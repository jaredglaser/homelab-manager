import type Dockerode from 'dockerode';

// The agent cannot replace its own container in-process: the stop kills this process and the replacement cannot bind the published port while the old one runs, so a short-lived helper container performs the swap.

export interface HandoverOptions {
  containerName: string;
  targetImage: string;
  agentPort: number;
}

export interface HandoverResult {
  previousImage: string;
  newImage: string;
  rolledBack: boolean;
}

// Docker's first health result only lands after one full interval, so a fixed
// 30s window races any image whose HEALTHCHECK interval is >= 30s.
export function deriveHealthWaitParams(healthcheck:
  | { Interval?: number; StartPeriod?: number; Retries?: number }
  | undefined): { maxAttempts: number; intervalMs: number } {
  if (!healthcheck?.Interval) {
    return { maxAttempts: 10, intervalMs: 3000 };
  }
  const intervalMs = healthcheck.Interval / 1e6;
  const startPeriodMs = (healthcheck.StartPeriod ?? 0) / 1e6;
  const retries = healthcheck.Retries && healthcheck.Retries > 0 ? healthcheck.Retries : 3;
  const totalMs = startPeriodMs + intervalMs * (retries + 1) + 10_000;
  const pollMs = Math.min(3000, intervalMs);
  return { maxAttempts: Math.ceil(totalMs / pollMs), intervalMs: pollMs };
}

export async function pullImage(docker: Dockerode, imageName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    docker.pull(imageName, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) {
        reject(err);
        return;
      }
      docker.modem.followProgress(stream, (progressErr: Error | null) => {
        if (progressErr) {
          reject(progressErr);
        } else {
          resolve();
        }
      });
    });
  });
}

function buildContainerOptions(
  image: string,
  info: Dockerode.ContainerInspectInfo,
  containerName: string,
): Dockerode.ContainerCreateOptions {
  return {
    name: containerName,
    Image: image,
    // CI stamps AGENT_VERSION into the image. Carrying the old one would
    // freeze the version the agent reports after an update.
    Env: info.Config.Env?.filter((entry) => !entry.startsWith('AGENT_VERSION=')),
    Cmd: info.Config.Cmd,
    Entrypoint: info.Config.Entrypoint,
    HostConfig: info.HostConfig,
    ExposedPorts: info.Config.ExposedPorts,
    Labels: info.Config.Labels,
    NetworkingConfig: {
      EndpointsConfig: info.NetworkSettings.Networks as Record<
        string,
        Dockerode.EndpointSettings
      >,
    },
  };
}

async function waitForHealthy(
  container: Dockerode.Container,
  agentPort: number,
  wait: { maxAttempts: number; intervalMs: number },
): Promise<boolean> {
  for (let attempt = 0; attempt < wait.maxAttempts; attempt++) {
    try {
      const info = await container.inspect();
      const healthStatus = info.State.Health?.Status;
      if (healthStatus === 'healthy') return true;
      if (healthStatus === 'unhealthy') return false;
      if (healthStatus === undefined && info.State.Running) {
        // No HEALTHCHECK on the image: probe /health over the internal network instead.
        const ipAddress = Object.values(info.NetworkSettings.Networks)[0]?.IPAddress;
        if (ipAddress) {
          const response = await fetch(`http://${ipAddress}:${agentPort}/health`, {
            signal: AbortSignal.timeout(2000),
          });
          if (response.ok) return true;
        }
      }
    } catch {
      // Container may not be ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, wait.intervalMs));
  }
  return false;
}

async function rollback(
  docker: Dockerode,
  failedContainer: Dockerode.Container | undefined,
  previousInfo: Dockerode.ContainerInspectInfo,
  previousImage: string,
): Promise<boolean> {
  try {
    if (failedContainer) {
      await failedContainer.stop().catch(() => {});
      await failedContainer.remove({ force: true }).catch(() => {});
    }
    const rolledBackContainer = await docker.createContainer(
      buildContainerOptions(previousImage, previousInfo, previousInfo.Name.replace(/^\//, '')),
    );
    await rolledBackContainer.start();
    console.info(`Rolled back to previous image: ${previousImage}`);
    return true;
  } catch (error) {
    console.error(
      'Rollback failed:',
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/** Pull the target image, replace the agent container with it, verify health, roll back on failure. */
export async function runAgentHandover(
  docker: Dockerode,
  opts: HandoverOptions,
): Promise<HandoverResult> {
  let previousImage: string | undefined;
  let containerInfo: Dockerode.ContainerInspectInfo | undefined;
  let teardownCompleted = false;
  let replacement: Dockerode.Container | undefined;

  try {
    const agent = docker.getContainer(opts.containerName);
    containerInfo = await agent.inspect();
    // Pin by digest or image ID: after the pull the old tag resolves to the
    // new image, which would make rollback a no-op.
    previousImage = containerInfo.Image;
    try {
      const imageInfo = await docker.getImage(containerInfo.Image).inspect();
      previousImage = imageInfo.RepoDigests?.[0] ?? containerInfo.Image;
    } catch {
      // Keep the image ID fallback.
    }

    console.info(`Pulling new agent image: ${opts.targetImage}`);
    await pullImage(docker, opts.targetImage);

    let wait = { maxAttempts: 10, intervalMs: 3000 };
    try {
      const imageInfo = await docker.getImage(opts.targetImage).inspect();
      wait = deriveHealthWaitParams(imageInfo.Config?.Healthcheck);
    } catch {
      // Default wait params.
    }

    console.info(`Stopping agent container: ${opts.containerName}`);
    await agent.stop();
    await agent.remove();
    teardownCompleted = true;

    console.info(`Creating agent container: ${opts.containerName}`);
    replacement = await docker.createContainer(
      buildContainerOptions(opts.targetImage, containerInfo, opts.containerName),
    );
    await replacement.start();

    if (!(await waitForHealthy(replacement, opts.agentPort, wait))) {
      console.info('Agent health check failed after update, rolling back');
      const rolledBack = await rollback(docker, replacement, containerInfo, previousImage);
      return { previousImage, newImage: opts.targetImage, rolledBack };
    }

    console.info(`Agent updated to ${opts.targetImage}`);
    return { previousImage, newImage: opts.targetImage, rolledBack: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Agent handover failed: ${message}`);
    if (teardownCompleted && previousImage && containerInfo) {
      const rolledBack = await rollback(docker, replacement, containerInfo, previousImage);
      return { previousImage, newImage: opts.targetImage, rolledBack };
    }
    throw error;
  }
}

/** Spawn the one-shot helper container that performs the handover, from the agent's own current image. */
export async function spawnUpdateHelper(
  docker: Dockerode,
  opts: HandoverOptions & { dockerHost?: string },
): Promise<Dockerode.Container> {
  const info = await docker.getContainer(opts.containerName).inspect();
  // The helper joins the agent's own networks so DOCKER_HOST's service name still resolves.
  // Aliases are dropped: a duplicate alias would point service DNS at both containers.
  const endpoints = Object.fromEntries(
    Object.keys(info.NetworkSettings.Networks).map((network) => [network, {}]),
  );
  const env = [
    `HLM_UPDATE_TARGET_IMAGE=${opts.targetImage}`,
    `HLM_UPDATE_CONTAINER=${opts.containerName}`,
    `HLM_UPDATE_AGENT_PORT=${opts.agentPort}`,
    ...(opts.dockerHost ? [`DOCKER_HOST=${opts.dockerHost}`] : []),
  ];
  const helper = await docker.createContainer({
    Image: info.Image,
    Cmd: ['bun', 'src/handover.ts'],
    Env: env,
    Labels: { 'hlm.managed': 'true', 'hlm.role': 'agent-update-helper' },
    HostConfig: { AutoRemove: true },
    NetworkingConfig: { EndpointsConfig: endpoints as Record<string, Dockerode.EndpointSettings> },
  });
  await helper.start();
  return helper;
}

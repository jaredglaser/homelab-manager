import type Dockerode from 'dockerode';

export const AUTO_UPDATE_ENV = 'HLM_AUTO_UPDATE';

export const DEFAULT_UPDATER_CONTAINER_NAME = 'hlm-agent-updater';

/**
 * Apply a per-agent auto-update policy by recreating the host's agent-updater
 * container with the matching HLM_AUTO_UPDATE env value. The agent never
 * touches its own container here, so it stays alive throughout; the updater
 * sidecar is stopped, removed, and recreated with the same configuration
 * except for the policy variable. Any in-flight update performed by the
 * sidecar is interrupted; callers should avoid flipping the policy while an
 * update is running.
 *
 * @param docker - Dockerode client, or null if Docker capability is not enabled
 * @param autoUpdate - Whether the agent-updater should apply updates automatically
 * @param updaterContainerName - Name of the agent-updater container to reconfigure
 * @returns 503 when Docker is disabled; 200 with { reconfigured } otherwise
 */
export async function handleAgentUpdaterPolicy(
  docker: Dockerode | null,
  autoUpdate: boolean,
  updaterContainerName: string = process.env.HLM_UPDATER_CONTAINER_NAME || DEFAULT_UPDATER_CONTAINER_NAME,
): Promise<Response> {
  if (!docker) {
    return Response.json({ error: 'Docker capability not enabled' }, { status: 503 });
  }

  const container = docker.getContainer(updaterContainerName);
  let info: Dockerode.ContainerInspectInfo;
  try {
    info = await container.inspect();
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 404) {
      return Response.json({
        reconfigured: false,
        reason: `No '${updaterContainerName}' container found on this host; there is nothing to auto-update. The setting is stored and applies to future agent stacks.`,
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to inspect ${updaterContainerName}: ${message}`);
    return Response.json({ reconfigured: false, reason: message }, { status: 500 });
  }

  try {
    if (info.State.Running) {
      await container.stop();
    }
    await container.remove();

    const env = (info.Config.Env ?? [])
      .filter((entry) => !entry.startsWith(`${AUTO_UPDATE_ENV}=`));
    env.push(`${AUTO_UPDATE_ENV}=${autoUpdate}`);

    const newContainer = await docker.createContainer({
      name: updaterContainerName,
      Image: info.Config.Image,
      Env: env,
      Cmd: info.Config.Cmd ?? undefined,
      Entrypoint: info.Config.Entrypoint ?? undefined,
      ExposedPorts: info.Config.ExposedPorts,
      Labels: info.Config.Labels ?? {},
      HostConfig: info.HostConfig,
    });
    await newContainer.start();

    console.info(`Reconfigured ${updaterContainerName} with ${AUTO_UPDATE_ENV}=${autoUpdate}`);
    return Response.json({ reconfigured: true, autoUpdate });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to reconfigure ${updaterContainerName}: ${message}`);
    return Response.json({ reconfigured: false, reason: message }, { status: 500 });
  }
}

/**
 * Parse and validate the request body for the policy endpoint.
 * Returns a Response on invalid input, or null when the body is valid.
 */
export async function parseUpdaterPolicyRequest(request: Request): Promise<{ autoUpdate: boolean } | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (typeof body !== 'object' || body === null || !('autoUpdate' in body)) {
    return Response.json({ error: 'Body must be an object with a boolean autoUpdate field' }, { status: 400 });
  }

  const { autoUpdate } = body as { autoUpdate: unknown };
  if (typeof autoUpdate !== 'boolean') {
    return Response.json({ error: 'autoUpdate must be a boolean' }, { status: 400 });
  }

  return { autoUpdate };
}

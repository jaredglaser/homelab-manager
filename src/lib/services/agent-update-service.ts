import type Dockerode from 'dockerode';
import { checkAgentHealth, type AgentHealthResult } from '@/lib/services/agent-health-service';
import { pullImage } from '@/lib/services/docker-image-utils';

const CONTAINER_NAME_PREFIX = 'homelab-agent-';
const HEALTH_CHECK_RETRY_DELAYS_MS = [500, 1000, 2000]; // Exponential backoff
const POST_UPDATE_HEALTH_CHECK_TIMEOUT_MS = 10000;

export interface AgentVersionCheck {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
}

export function checkAgentVersion(currentVersion: string, latestVersion: string): AgentVersionCheck {
  return {
    currentVersion,
    latestVersion,
    updateAvailable: currentVersion !== latestVersion,
  };
}

export type AgentUpdateResult = AgentHealthResult & { containerName: string };

/**
 * Service for updating agent containers via socket proxy bypass.
 *
 * The update bypasses the agent itself (which can't replace its own container)
 * by connecting directly to the host's socket proxy URL via Dockerode.
 *
 * Sequence: pull new image -> inspect old container -> stop old -> remove old
 *           -> create new with same config -> start new -> verify health
 */
export class AgentUpdateService {
  /**
   * Update an agent container to a new image version.
   *
   * @param docker - Dockerode instance connected to the host's socket proxy
   * @param hostId - Numeric host ID (used to derive container name)
   * @param newImage - New agent image to pull and deploy
   * @returns Health check result after update
   */
  async updateAgent(
    docker: Dockerode,
    hostId: number,
    newImage: string,
    fetchFn: typeof fetch = globalThis.fetch
  ): Promise<AgentUpdateResult> {
    const containerName = `${CONTAINER_NAME_PREFIX}${hostId}`;

    // 1. Pull the new image
    await pullImage(docker, newImage);

    // 2. Inspect the existing container to capture its config
    const existingContainer = docker.getContainer(containerName);
    const inspectData = await existingContainer.inspect();

    const oldEnv = inspectData.Config.Env || [];
    const oldHostConfig = inspectData.HostConfig;

    // The old container is destroyed before the new one is verified healthy.
    // A blue-green approach (start new, verify, then remove old) would be safer
    // but requires different container names and port handling. The restart
    // policy and health check retries mitigate the risk for now.
    // 3. Stop and remove the old container
    if (inspectData.State.Running) {
      await existingContainer.stop();
    }
    await existingContainer.remove();

    // 4. Create the new container with the same config but new image
    const newContainer = await docker.createContainer({
      name: containerName,
      Image: newImage,
      Env: oldEnv,
      ExposedPorts: inspectData.Config.ExposedPorts,
      HostConfig: {
        Binds: oldHostConfig.Binds,
        PortBindings: oldHostConfig.PortBindings,
        RestartPolicy: oldHostConfig.RestartPolicy,
      },
    });

    // 5. Start the new container
    await newContainer.start();

    // 6. Verify health with exponential backoff retry (matches BaseCollector pattern)
    const agentPort = this.extractAgentPort(oldHostConfig.PortBindings);
    const dockerHost = this.extractHostFromEnv(oldEnv);
    const agentUrl = `http://${dockerHost}:${agentPort}`;

    let healthResult: Awaited<ReturnType<typeof checkAgentHealth>> = {
      healthy: false,
      error: 'Health check not attempted',
    };

    for (let i = 0; i < HEALTH_CHECK_RETRY_DELAYS_MS.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, HEALTH_CHECK_RETRY_DELAYS_MS[i]));
      healthResult = await checkAgentHealth(agentUrl, POST_UPDATE_HEALTH_CHECK_TIMEOUT_MS, fetchFn);
      if (healthResult.healthy) break;
      console.error(
        `[AgentUpdateService] Health check attempt ${i + 1}/${HEALTH_CHECK_RETRY_DELAYS_MS.length} failed for ${containerName}: ${healthResult.error}`
      );
    }

    return {
      ...healthResult,
      containerName,
    };
  }

  private extractAgentPort(portBindings: Record<string, { HostPort: string }[]>): number {
    const keys = Object.keys(portBindings);
    if (keys.length === 0) {
      throw new Error('Container has no port bindings; cannot determine agent port for health check');
    }
    const binding = portBindings[keys[0]];
    if (!binding || binding.length === 0) {
      throw new Error('Container port binding has no host port entries');
    }
    const port = Number(binding[0].HostPort);
    if (!Number.isFinite(port) || port <= 0) {
      throw new Error(`Container port binding has invalid HostPort: ${binding[0].HostPort}`);
    }
    return port;
  }

  private extractHostFromEnv(env: string[]): string {
    const dockerHostEntry = env.find((e) => e.startsWith('DOCKER_HOST='));
    if (!dockerHostEntry) {
      throw new Error('Container env is missing DOCKER_HOST; cannot determine agent host for health check');
    }
    const dockerHostUrl = dockerHostEntry.substring(dockerHostEntry.indexOf('=') + 1);
    const parsed = new URL(dockerHostUrl.replace(/^tcp:\/\//, 'http://'));
    return parsed.hostname;
  }
}

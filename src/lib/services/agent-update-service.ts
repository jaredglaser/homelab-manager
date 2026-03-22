import type Dockerode from 'dockerode';
import { checkAgentHealth, type AgentHealthResult } from '@/lib/services/agent-health-service';
import { pullImage } from '@/lib/services/docker-image-utils';
import { getAgentContainerName } from '@/lib/services/agent-constants';
const HEALTH_CHECK_RETRY_DELAYS_MS = [500, 1000, 2000]; // Exponential backoff
const POST_UPDATE_HEALTH_CHECK_TIMEOUT_MS = 10000;
const ROLLBACK_CONTAINER_SUFFIX = '-old';

export type AgentUpdateResult = AgentHealthResult & { containerName: string };

/**
 * Service for updating agent containers via socket proxy bypass.
 *
 * The update bypasses the agent itself (which can't replace its own container)
 * by connecting directly to the host's socket proxy URL via Dockerode.
 *
 * Sequence: pull new image -> inspect old container -> rename old -> create new
 *           with same config -> start new -> verify health -> remove old
 *           On failure: remove new -> rename old back -> restart old
 */
export class AgentUpdateService {
  /**
   * Update an agent container to a new image version.
   * Uses a safe rollback approach: the old container is kept until the new one is verified healthy.
   */
  async updateAgent(
    docker: Dockerode,
    hostId: number,
    newImage: string,
    fetchFn: typeof fetch = globalThis.fetch
  ): Promise<AgentUpdateResult> {
    const containerName = getAgentContainerName(hostId);
    const rollbackName = `${containerName}${ROLLBACK_CONTAINER_SUFFIX}`;

    // 1. Pull the new image
    await pullImage(docker, newImage);

    // 2. Inspect the existing container to capture its config
    const existingContainer = docker.getContainer(containerName);
    const inspectData = await existingContainer.inspect();

    const oldEnv = inspectData.Config.Env || [];
    const oldHostConfig = inspectData.HostConfig;
    const oldNetworkingConfig = inspectData.NetworkSettings?.Networks;

    // 3. Stop and rename the old container (keep it for rollback)
    if (inspectData.State.Running) {
      await existingContainer.stop();
    }
    await existingContainer.rename({ name: rollbackName });

    // 4. Create the new container with the same config but new image
    let newContainer: Dockerode.Container;
    try {
      newContainer = await docker.createContainer({
        name: containerName,
        Image: newImage,
        Env: oldEnv,
        ExposedPorts: inspectData.Config.ExposedPorts,
        HostConfig: {
          Binds: oldHostConfig.Binds,
          PortBindings: oldHostConfig.PortBindings,
          RestartPolicy: oldHostConfig.RestartPolicy,
          NetworkMode: oldHostConfig.NetworkMode,
        },
        NetworkingConfig: oldNetworkingConfig ? {
          EndpointsConfig: oldNetworkingConfig,
        } : undefined,
      });
    } catch (err) {
      // Rollback: rename old container back and restart it
      await this.rollback(docker, rollbackName, containerName);
      throw err;
    }

    // 5. Start the new container
    try {
      await newContainer.start();
    } catch (err) {
      // Rollback: remove failed new container, rename old back, restart
      await this.safeRemove(docker, containerName);
      await this.rollback(docker, rollbackName, containerName);
      throw err;
    }

    // 6. Verify health using the host IP from port bindings
    const agentPort = this.extractAgentPort(oldHostConfig.PortBindings);
    const hostIp = this.extractHostIp(oldHostConfig.PortBindings);
    const agentUrl = `http://${hostIp}:${agentPort}`;

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

    if (!healthResult.healthy) {
      // Rollback: remove unhealthy new container, restore old
      await this.safeRemove(docker, containerName);
      await this.rollback(docker, rollbackName, containerName);
      return { ...healthResult, containerName };
    }

    // 7. Success — remove the old container
    await this.safeRemove(docker, rollbackName);

    return {
      ...healthResult,
      containerName,
    };
  }

  /** Rename the rollback container back to original name and restart it. */
  private async rollback(docker: Dockerode, rollbackName: string, originalName: string): Promise<void> {
    const old = docker.getContainer(rollbackName);
    await old.rename({ name: originalName });
    await old.start();
  }

  /** Remove a container, ignoring 404 (already removed). */
  private async safeRemove(docker: Dockerode, name: string): Promise<void> {
    try {
      const c = docker.getContainer(name);
      try { await c.stop(); } catch { /* may not be running */ }
      await c.remove();
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 404) return;
      console.error(`[AgentUpdateService] Failed to remove container ${name}:`, err);
    }
  }

  private extractAgentPort(portBindings: Record<string, { HostPort: string; HostIp?: string }[]>): number {
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

  /** Extract the host IP from port bindings. Falls back to '127.0.0.1' if HostIp is empty/0.0.0.0. */
  private extractHostIp(portBindings: Record<string, { HostPort: string; HostIp?: string }[]>): string {
    const keys = Object.keys(portBindings);
    if (keys.length === 0) {
      throw new Error('Container has no port bindings; cannot determine host IP for health check');
    }
    const binding = portBindings[keys[0]];
    if (!binding || binding.length === 0) {
      throw new Error('Container port binding has no host port entries');
    }
    const ip = binding[0].HostIp;
    // Docker uses empty string or 0.0.0.0 for "all interfaces" — not useful for health checks
    if (!ip || ip === '0.0.0.0' || ip === '::') {
      return '127.0.0.1';
    }
    return ip;
  }
}

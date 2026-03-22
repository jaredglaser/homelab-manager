import type Dockerode from 'dockerode';
import { pullImage } from '@/lib/services/docker-image-utils';
import { getAgentContainerName } from '@/lib/services/agent-constants';

export interface ProvisionAgentOptions {
  hostId: number;
  agentPort: number;
  agentToken: string;
  agentImage: string;
  socketProxyUrl: string;
  /** IP to bind the agent port to. Defaults to the socket proxy hostname. */
  hostIp?: string;
}

export interface ProvisionAgentResult {
  containerName: string;
  agentUrl: string;
}
const STACKS_VOLUME = 'homelab-stacks';
const STACKS_MOUNT_PATH = '/opt/homelab-manager/stacks';

/**
 * Service for provisioning and managing agent containers on Docker hosts.
 * Connects to the host's socket proxy via Dockerode to pull images,
 * create containers, and manage lifecycle.
 */
export class AgentProvisioningService {
  /**
   * Build the standard container name for a host using its immutable DB ID.
   */
  getContainerName(hostId: number): string {
    return getAgentContainerName(hostId);
  }

  /**
   * Provision an agent container on a Docker host via socket proxy.
   *
   * 1. Pull (or verify) the agent image
   * 2. Remove any existing agent container for this host
   * 3. Create and start the new agent container
   */
  async provision(
    docker: Dockerode,
    options: ProvisionAgentOptions
  ): Promise<ProvisionAgentResult> {
    const containerName = this.getContainerName(options.hostId);

    // Pull the agent image
    await pullImage(docker, options.agentImage);

    // Remove existing agent container if present
    await this.removeExistingContainer(docker, containerName);

    // Derive the host IP from the socket proxy URL if not explicitly provided.
    const proxyUrl = new URL(options.socketProxyUrl.replace(/^tcp:\/\//, 'http://'));
    const bindIp = options.hostIp ?? proxyUrl.hostname;

    // Create the agent container
    const container = await docker.createContainer({
      name: containerName,
      Image: options.agentImage,
      Env: [
        `AGENT_TOKEN=${options.agentToken}`,
        `DOCKER_HOST=${options.socketProxyUrl}`,
        `AGENT_PORT=${options.agentPort}`,
      ],
      ExposedPorts: {
        [`${options.agentPort}/tcp`]: {},
      },
      HostConfig: {
        Binds: [`${STACKS_VOLUME}:${STACKS_MOUNT_PATH}`],
        PortBindings: {
          [`${options.agentPort}/tcp`]: [{ HostIp: bindIp, HostPort: String(options.agentPort) }],
        },
        RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      },
    });

    await container.start();

    const agentUrl = `http://${bindIp}:${options.agentPort}`;

    return { containerName, agentUrl };
  }

  /**
   * Remove an agent container from a Docker host.
   * Stops the container if running, then removes it.
   * No-op if the container does not exist.
   */
  async removeAgent(docker: Dockerode, hostId: number): Promise<void> {
    const containerName = this.getContainerName(hostId);
    await this.removeExistingContainer(docker, containerName);
  }

  private async removeExistingContainer(
    docker: Dockerode,
    containerName: string
  ): Promise<void> {
    const container = docker.getContainer(containerName);
    try {
      const info = await container.inspect();
      if (info.State.Running) {
        await container.stop();
      }
      await container.remove();
    } catch (err: unknown) {
      // 404 means container doesn't exist — that's fine
      if (
        err &&
        typeof err === 'object' &&
        'statusCode' in err &&
        (err as { statusCode: number }).statusCode === 404
      ) {
        return;
      }
      throw err;
    }
  }
}

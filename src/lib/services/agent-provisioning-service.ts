import type Dockerode from 'dockerode';
import { pullImage } from '@/lib/services/docker-image-utils';

export interface ProvisionAgentOptions {
  hostId: number;
  agentPort: number;
  agentToken: string;
  agentImage: string;
  socketProxyUrl: string;
}

export interface ProvisionAgentResult {
  containerName: string;
  agentUrl: string;
}

const CONTAINER_NAME_PREFIX = 'homelab-agent-';
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
    return `${CONTAINER_NAME_PREFIX}${hostId}`;
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
        // TODO: investigate binding to a specific HostIp (e.g. management interface)
        // instead of 0.0.0.0 to limit agent exposure to the management network
        PortBindings: {
          [`${options.agentPort}/tcp`]: [{ HostPort: String(options.agentPort) }],
        },
        RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      },
    });

    await container.start();

    // The agent URL must use the host's IP/hostname (not the container name),
    // because the container DNS name is only resolvable within the same Docker
    // network. Extract the host from the socket proxy URL.
    const proxyUrl = new URL(options.socketProxyUrl.replace(/^tcp:\/\//, 'http://'));
    const agentUrl = `http://${proxyUrl.hostname}:${options.agentPort}`;

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

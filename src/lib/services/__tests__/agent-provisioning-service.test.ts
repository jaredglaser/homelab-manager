import { describe, it, expect, beforeEach } from 'bun:test';
import { AgentProvisioningService } from '../agent-provisioning-service';
import type { ProvisionAgentOptions } from '../agent-provisioning-service';

// Mock Dockerode for testing
function createMockDockerode() {
  const pulledImages: string[] = [];
  const createdContainers: { name: string; config: Record<string, unknown> }[] = [];
  const startedContainers: string[] = [];
  const stoppedContainers: string[] = [];
  const removedContainers: string[] = [];
  const inspectedContainers: string[] = [];
  let containerExists = false;
  let containerRunning = false;

  const mockContainer = {
    start: async () => {
      startedContainers.push('mock-container');
    },
    stop: async () => {
      stoppedContainers.push('mock-container');
    },
    remove: async () => {
      removedContainers.push('mock-container');
    },
    inspect: async () => {
      inspectedContainers.push('mock-container');
      if (!containerExists) {
        const err = new Error('No such container') as any;
        err.statusCode = 404;
        throw err;
      }
      return {
        State: { Running: containerRunning },
        Config: { Image: 'ghcr.io/org/homelab-manager-agent:latest' },
      };
    },
  };

  const docker = {
    pull: async (image: string) => {
      pulledImages.push(image);
      // Return a mock stream that resolves immediately
      return { pipe: () => {}, on: (_e: string, cb: () => void) => { if (_e === 'end') cb(); } };
    },
    createContainer: async (config: Record<string, unknown>) => {
      const name = (config.name as string) || 'unnamed';
      createdContainers.push({ name, config });
      return mockContainer;
    },
    getContainer: (_id: string) => mockContainer,
    modem: {
      followProgress: (_stream: any, callback: (err: Error | null, output: unknown[]) => void) => {
        callback(null, []);
      },
    },
  } as any;

  return {
    docker,
    pulledImages,
    createdContainers,
    startedContainers,
    stoppedContainers,
    removedContainers,
    inspectedContainers,
    setContainerExists(exists: boolean) {
      containerExists = exists;
    },
    setContainerRunning(running: boolean) {
      containerRunning = running;
      containerExists = true;
    },
  };
}

describe('AgentProvisioningService', () => {
  let service: AgentProvisioningService;
  let mockDocker: ReturnType<typeof createMockDockerode>;

  const defaultOptions: ProvisionAgentOptions = {
    hostId: 1,
    agentPort: 9090,
    publicJwkJson: '{"kty":"OKP","crv":"Ed25519","x":"test-public-key"}',
    agentImage: 'ghcr.io/org/homelab-manager-agent:latest',
    socketProxyUrl: 'tcp://192.168.1.10:2375',
  };

  beforeEach(() => {
    mockDocker = createMockDockerode();
    service = new AgentProvisioningService();
  });

  describe('provision', () => {
    it('pulls the agent image', async () => {
      await service.provision(mockDocker.docker, defaultOptions);
      expect(mockDocker.pulledImages).toContain('ghcr.io/org/homelab-manager-agent:latest');
    });

    it('creates a container with the correct name convention', async () => {
      await service.provision(mockDocker.docker, defaultOptions);
      expect(mockDocker.createdContainers).toHaveLength(1);
      expect(mockDocker.createdContainers[0].name).toBe('homelab-agent-1');
    });

    it('passes AGENT_TRUSTED_PUBKEY and DOCKER_HOST as env vars', async () => {
      await service.provision(mockDocker.docker, defaultOptions);
      const config = mockDocker.createdContainers[0].config;
      const env = config.Env as string[];
      expect(env).toContainEqual('AGENT_TRUSTED_PUBKEY={"kty":"OKP","crv":"Ed25519","x":"test-public-key"}');
      expect(env).toContainEqual('DOCKER_HOST=tcp://192.168.1.10:2375');
      expect(env).toContainEqual('AGENT_PORT=9090');
    });

    it('mounts homelab-stacks volume', async () => {
      await service.provision(mockDocker.docker, defaultOptions);
      const config = mockDocker.createdContainers[0].config;
      const hostConfig = config.HostConfig as Record<string, unknown>;
      const binds = hostConfig.Binds as string[];
      expect(binds).toContainEqual('homelab-stacks:/opt/homelab-manager/stacks');
    });

    it('starts the container after creation', async () => {
      await service.provision(mockDocker.docker, defaultOptions);
      expect(mockDocker.startedContainers).toHaveLength(1);
    });

    it('returns the agent URL using host IP from socket proxy URL', async () => {
      const result = await service.provision(mockDocker.docker, defaultOptions);
      expect(result.containerName).toBe('homelab-agent-1');
      expect(result.agentUrl).toBe('http://192.168.1.10:9090');
    });

    it('removes existing container before creating new one', async () => {
      mockDocker.setContainerRunning(true);
      await service.provision(mockDocker.docker, defaultOptions);
      expect(mockDocker.stoppedContainers).toHaveLength(1);
      expect(mockDocker.removedContainers).toHaveLength(1);
      expect(mockDocker.createdContainers).toHaveLength(1);
    });
  });

  describe('removeAgent', () => {
    it('stops and removes the container', async () => {
      mockDocker.setContainerRunning(true);
      await service.removeAgent(mockDocker.docker, 1);
      expect(mockDocker.stoppedContainers).toHaveLength(1);
      expect(mockDocker.removedContainers).toHaveLength(1);
    });

    it('handles container not found gracefully', async () => {
      mockDocker.setContainerExists(false);
      // Should not throw
      await service.removeAgent(mockDocker.docker, 999);
    });

    it('handles already-stopped container', async () => {
      mockDocker.setContainerExists(true);
      mockDocker.setContainerRunning(false);
      // stop() will be called but that's fine, Dockerode handles it
      await service.removeAgent(mockDocker.docker, 1);
      expect(mockDocker.removedContainers).toHaveLength(1);
    });

    it('rethrows non-404 errors from inspect', async () => {
      const serverError = new Error('Internal server error') as Error & { statusCode: number };
      serverError.statusCode = 500;
      const failingDocker = {
        ...mockDocker.docker,
        getContainer: () => ({
          inspect: async () => { throw serverError; },
          stop: async () => {},
          remove: async () => {},
        }),
      } as any;

      await expect(service.removeAgent(failingDocker, 1)).rejects.toThrow('Internal server error');
    });
  });
});

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { AgentUpdateService } from '../agent-update-service';

function createMockDockerode() {
  const pulledImages: string[] = [];
  const stoppedContainers: string[] = [];
  const removedContainers: string[] = [];
  const createdContainers: { name: string; config: Record<string, unknown> }[] = [];
  const startedContainers: string[] = [];

  const mockContainer = {
    inspect: async () => ({
      State: { Running: true },
      Config: {
        Image: 'ghcr.io/org/homelab-manager-agent:latest',
        Env: [
          'AGENT_TOKEN=existing-token',
          'DOCKER_HOST=tcp://192.168.1.10:2375',
          'AGENT_PORT=9090',
        ],
        ExposedPorts: { '9090/tcp': {} },
      },
      HostConfig: {
        Binds: ['homelab-stacks:/opt/homelab-manager/stacks'],
        PortBindings: { '9090/tcp': [{ HostPort: '9090' }] },
        RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      },
      Name: '/homelab-agent-1',
    }),
    stop: async () => {
      stoppedContainers.push('homelab-agent-1');
    },
    remove: async () => {
      removedContainers.push('homelab-agent-1');
    },
    start: async () => {
      startedContainers.push('homelab-agent-1');
    },
  };

  const docker = {
    pull: async (image: string) => {
      pulledImages.push(image);
      return {};
    },
    getContainer: (_name: string) => mockContainer,
    createContainer: async (config: Record<string, unknown>) => {
      createdContainers.push({ name: config.name as string, config });
      return mockContainer;
    },
    modem: {
      followProgress: (_stream: any, callback: (err: Error | null, output: unknown[]) => void) => {
        callback(null, []);
      },
    },
  } as any;

  return {
    docker,
    pulledImages,
    stoppedContainers,
    removedContainers,
    createdContainers,
    startedContainers,
  };
}

describe('AgentUpdateService', () => {
  let service: AgentUpdateService;
  let mockDocker: ReturnType<typeof createMockDockerode>;
  let mockFetchFn: typeof fetch;

  beforeEach(() => {
    service = new AgentUpdateService();
    mockDocker = createMockDockerode();
    mockFetchFn = mock(async () =>
      new Response(JSON.stringify({ status: 'ok', version: '0.2.0' }), { status: 200 })
    ) as unknown as typeof fetch;
  });

  describe('updateAgent', () => {
    const realSetTimeout = globalThis.setTimeout;
    let setTimeoutSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
        ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
          // Fire retry delays (≤2000ms) immediately; pass everything else through
          // so AbortSignal.timeout and other internals work normally.
          if (typeof fn === 'function' && (ms === undefined || ms <= 2000)) {
            fn();
            return 0;
          }
          return realSetTimeout(fn, ms, ...args);
        }) as unknown as typeof setTimeout
      );
    });

    afterEach(() => {
      setTimeoutSpy.mockRestore();
    });

    it('pulls the new image via socket proxy', async () => {
      await service.updateAgent(mockDocker.docker, 1, 'ghcr.io/org/homelab-manager-agent:latest', mockFetchFn);

      expect(mockDocker.pulledImages).toContain('ghcr.io/org/homelab-manager-agent:latest');
    });

    it('stops and removes the old container', async () => {
      await service.updateAgent(mockDocker.docker, 1, 'ghcr.io/org/homelab-manager-agent:latest', mockFetchFn);

      expect(mockDocker.stoppedContainers).toHaveLength(1);
      expect(mockDocker.removedContainers).toHaveLength(1);
    });

    it('creates a new container with the same config', async () => {
      await service.updateAgent(mockDocker.docker, 1, 'ghcr.io/org/homelab-manager-agent:latest', mockFetchFn);

      expect(mockDocker.createdContainers).toHaveLength(1);
      expect(mockDocker.createdContainers[0].name).toBe('homelab-agent-1');
    });

    it('starts the new container', async () => {
      await service.updateAgent(mockDocker.docker, 1, 'ghcr.io/org/homelab-manager-agent:latest', mockFetchFn);

      expect(mockDocker.startedContainers).toHaveLength(1);
    });

    it('preserves env vars from the old container', async () => {
      await service.updateAgent(mockDocker.docker, 1, 'ghcr.io/org/homelab-manager-agent:latest', mockFetchFn);

      const config = mockDocker.createdContainers[0].config;
      const env = config.Env as string[];
      expect(env).toContainEqual('AGENT_TOKEN=existing-token');
      expect(env).toContainEqual('DOCKER_HOST=tcp://192.168.1.10:2375');
    });

    it('returns the new version from health check', async () => {
      const result = await service.updateAgent(
        mockDocker.docker,
        1,
        'ghcr.io/org/homelab-manager-agent:latest',
        mockFetchFn
      );

      expect(result.healthy).toBe(true);
      if (result.healthy) expect(result.version).toBe('0.2.0');
    });

    it('skips stop when container is not running', async () => {
      const dockerStopped = createMockDockerode();
      const originalGetContainer = dockerStopped.docker.getContainer;
      dockerStopped.docker.getContainer = (_name: string) => {
        const container = originalGetContainer(_name);
        const originalInspect = container.inspect;
        container.inspect = async () => {
          const data = await originalInspect();
          data.State.Running = false;
          return data;
        };
        return container;
      };

      await service.updateAgent(dockerStopped.docker, 1, 'ghcr.io/org/homelab-manager-agent:latest', mockFetchFn);

      expect(dockerStopped.stoppedContainers).toHaveLength(0);
      expect(dockerStopped.removedContainers).toHaveLength(1);
      expect(dockerStopped.createdContainers).toHaveLength(1);
      expect(dockerStopped.startedContainers).toHaveLength(1);
    });

    it('throws when container has no port bindings', async () => {
      const dockerNoBindings = createMockDockerode();
      const originalGetContainer = dockerNoBindings.docker.getContainer;
      dockerNoBindings.docker.getContainer = (_name: string) => {
        const container = originalGetContainer(_name);
        const originalInspect = container.inspect;
        container.inspect = async () => {
          const data = await originalInspect();
          data.HostConfig.PortBindings = {};
          return data;
        };
        return container;
      };

      await expect(
        service.updateAgent(dockerNoBindings.docker, 1, 'agent:latest', mockFetchFn)
      ).rejects.toThrow('no port bindings');
    });

    it('throws when container env is missing DOCKER_HOST', async () => {
      const dockerNoEnv = createMockDockerode();
      const originalGetContainer = dockerNoEnv.docker.getContainer;
      dockerNoEnv.docker.getContainer = (_name: string) => {
        const container = originalGetContainer(_name);
        const originalInspect = container.inspect;
        container.inspect = async () => {
          const data = await originalInspect();
          data.Config.Env = ['AGENT_TOKEN=token'];
          return data;
        };
        return container;
      };

      await expect(
        service.updateAgent(dockerNoEnv.docker, 1, 'agent:latest', mockFetchFn)
      ).rejects.toThrow('missing DOCKER_HOST');
    });

    it('logs each retry attempt and returns unhealthy when all health checks fail', async () => {
      const consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

      const unhealthyFetch = mock(async () =>
        new Response(JSON.stringify({ error: 'service unavailable' }), { status: 503 })
      ) as unknown as typeof fetch;

      try {
        const result = await service.updateAgent(mockDocker.docker, 1, 'agent:latest', unhealthyFetch);

        expect(result.healthy).toBe(false);
        const retryCalls = consoleErrorSpy.mock.calls.filter(
          (args) => typeof args[0] === 'string' && args[0].includes('[AgentUpdateService]')
        );
        expect(retryCalls).toHaveLength(3);
        expect(retryCalls[0][0]).toContain('Health check attempt 1/3 failed for homelab-agent-1');
        expect(retryCalls[1][0]).toContain('Health check attempt 2/3 failed for homelab-agent-1');
        expect(retryCalls[2][0]).toContain('Health check attempt 3/3 failed for homelab-agent-1');
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });

    it('throws when port binding key exists but has an empty array of host entries', async () => {
      const dockerEmptyBindings = createMockDockerode();
      const originalGetContainer = dockerEmptyBindings.docker.getContainer;
      dockerEmptyBindings.docker.getContainer = (_name: string) => {
        const container = originalGetContainer(_name);
        const originalInspect = container.inspect;
        container.inspect = async () => {
          const data = await originalInspect();
          data.HostConfig.PortBindings = { '9090/tcp': [] };
          return data;
        };
        return container;
      };

      await expect(
        service.updateAgent(dockerEmptyBindings.docker, 1, 'agent:latest', mockFetchFn)
      ).rejects.toThrow('Container port binding has no host port entries');
    });
  });
});

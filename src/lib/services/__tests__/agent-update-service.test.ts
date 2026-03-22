import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { AgentUpdateService } from '../agent-update-service';

function createMockDockerode(options?: {
  portBindings?: Record<string, { HostPort: string; HostIp?: string }[]>;
  networkSettings?: Record<string, unknown>;
}) {
  const pulledImages: string[] = [];
  const stoppedContainers: string[] = [];
  const removedContainers: string[] = [];
  const renamedContainers: { from: string; to: string }[] = [];
  const createdContainers: { name: string; config: Record<string, unknown> }[] = [];
  const startedContainers: string[] = [];

  const portBindings = options?.portBindings ?? {
    '9090/tcp': [{ HostPort: '9090', HostIp: '192.168.1.10' }],
  };

  // Track container names so getContainer returns the right mock
  const containerState = new Map<string, { running: boolean; exists: boolean }>();
  containerState.set('homelab-agent-1', { running: true, exists: true });

  function makeContainer(name: string) {
    return {
      inspect: async () => ({
        State: { Running: containerState.get(name)?.running ?? false },
        Config: {
          Image: 'ghcr.io/org/homelab-manager-agent:latest',
          Env: [
            'AGENT_TOKEN=existing-token',
            'DOCKER_HOST=tcp://socket-proxy:2375',
            'AGENT_PORT=9090',
          ],
          ExposedPorts: { '9090/tcp': {} },
        },
        HostConfig: {
          Binds: ['homelab-stacks:/opt/homelab-manager/stacks'],
          PortBindings: portBindings,
          RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
          NetworkMode: 'custom-network',
        },
        NetworkSettings: {
          Networks: options?.networkSettings ?? {
            'custom-network': { NetworkID: 'abc123' },
          },
        },
        Name: `/${name}`,
      }),
      stop: async () => { stoppedContainers.push(name); },
      remove: async () => { removedContainers.push(name); },
      start: async () => { startedContainers.push(name); },
      rename: async ({ name: newName }: { name: string }) => {
        renamedContainers.push({ from: name, to: newName });
      },
    };
  }

  const docker = {
    pull: async (image: string) => {
      pulledImages.push(image);
      return {};
    },
    getContainer: (name: string) => makeContainer(name),
    createContainer: async (config: Record<string, unknown>) => {
      createdContainers.push({ name: config.name as string, config });
      return makeContainer(config.name as string);
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
    renamedContainers,
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
    it('pulls the new image via socket proxy', async () => {
      await service.updateAgent(mockDocker.docker, 1, 'ghcr.io/org/homelab-manager-agent:latest', mockFetchFn);
      expect(mockDocker.pulledImages).toContain('ghcr.io/org/homelab-manager-agent:latest');
    });

    it('renames old container before creating new one', async () => {
      await service.updateAgent(mockDocker.docker, 1, 'agent:latest', mockFetchFn);
      expect(mockDocker.renamedContainers).toHaveLength(1);
      expect(mockDocker.renamedContainers[0]).toEqual({
        from: 'homelab-agent-1',
        to: 'homelab-agent-1-old',
      });
    });

    it('creates a new container with the same config', async () => {
      await service.updateAgent(mockDocker.docker, 1, 'agent:latest', mockFetchFn);
      expect(mockDocker.createdContainers).toHaveLength(1);
      expect(mockDocker.createdContainers[0].name).toBe('homelab-agent-1');
    });

    it('preserves env vars from the old container', async () => {
      await service.updateAgent(mockDocker.docker, 1, 'agent:latest', mockFetchFn);
      const config = mockDocker.createdContainers[0].config;
      const env = config.Env as string[];
      expect(env).toContainEqual('AGENT_TOKEN=existing-token');
      expect(env).toContainEqual('DOCKER_HOST=tcp://socket-proxy:2375');
    });

    it('preserves network mode and networking config', async () => {
      await service.updateAgent(mockDocker.docker, 1, 'agent:latest', mockFetchFn);
      const config = mockDocker.createdContainers[0].config;
      const hostConfig = config.HostConfig as Record<string, unknown>;
      expect(hostConfig.NetworkMode).toBe('custom-network');
      const networkingConfig = config.NetworkingConfig as Record<string, unknown>;
      expect(networkingConfig).toBeDefined();
    });

    it('removes old container after successful health check', async () => {
      await service.updateAgent(mockDocker.docker, 1, 'agent:latest', mockFetchFn);
      // Old container should be removed (the renamed one)
      expect(mockDocker.removedContainers.length).toBeGreaterThanOrEqual(1);
    });

    it('returns the new version from health check', async () => {
      const result = await service.updateAgent(mockDocker.docker, 1, 'agent:latest', mockFetchFn);
      expect(result.healthy).toBe(true);
      if (result.healthy) expect(result.version).toBe('0.2.0');
    });

    it('uses HostIp from port bindings for health check URL', async () => {
      const fetchSpy = mock(async (url: string | URL | Request) => {
        expect(String(url)).toContain('192.168.1.10');
        return new Response(JSON.stringify({ status: 'ok', version: '1.0.0' }), { status: 200 });
      }) as unknown as typeof fetch;

      await service.updateAgent(mockDocker.docker, 1, 'agent:latest', fetchSpy);
    });

    it('falls back to 127.0.0.1 when HostIp is empty', async () => {
      const noIpDocker = createMockDockerode({
        portBindings: { '9090/tcp': [{ HostPort: '9090' }] },
      });
      const fetchSpy = mock(async (url: string | URL | Request) => {
        expect(String(url)).toContain('127.0.0.1');
        return new Response(JSON.stringify({ status: 'ok', version: '1.0.0' }), { status: 200 });
      }) as unknown as typeof fetch;

      await service.updateAgent(noIpDocker.docker, 1, 'agent:latest', fetchSpy);
    });

    it('rolls back on health check failure', async () => {
      const failFetch = mock(async () =>
        new Response('', { status: 500 })
      ) as unknown as typeof fetch;

      const result = await service.updateAgent(mockDocker.docker, 1, 'agent:latest', failFetch);
      expect(result.healthy).toBe(false);
      // Should have renamed old back and restarted it
      expect(mockDocker.renamedContainers.length).toBeGreaterThanOrEqual(2);
      const rollbackRename = mockDocker.renamedContainers[1];
      expect(rollbackRename.from).toBe('homelab-agent-1-old');
      expect(rollbackRename.to).toBe('homelab-agent-1');
    });

    it('throws when container has no port bindings', async () => {
      const dockerNoBindings = createMockDockerode({
        portBindings: {},
      });

      await expect(
        service.updateAgent(dockerNoBindings.docker, 1, 'agent:latest', mockFetchFn)
      ).rejects.toThrow('no port bindings');
    });
  });
});

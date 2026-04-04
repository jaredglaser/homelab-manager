import { describe, expect, test, mock, beforeAll, spyOn } from 'bun:test';
import type Dockerode from 'dockerode';
import { handleAgentUpdate } from '../routes/agent-update';

beforeAll(() => {
  console.error = mock(() => {});
});

function createMockDocker() {
  const mockContainer = {
    inspect: mock(() =>
      Promise.resolve({
        Image: 'ghcr.io/homelab-manager/agent:latest',
        Config: {
          Env: ['AGENT_TOKEN=abc'],
          ExposedPorts: { '9090/tcp': {} },
        },
        HostConfig: {
          Binds: ['/var/run/docker.sock:/var/run/docker.sock'],
          PortBindings: { '9090/tcp': [{ HostPort: '9090' }] },
          RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
          NetworkMode: 'bridge',
        },
        NetworkSettings: {
          Networks: { bridge: {} },
        },
      })
    ),
    stop: mock(() => Promise.resolve()),
    remove: mock(() => Promise.resolve()),
    start: mock(() => Promise.resolve()),
    id: 'new-container-id',
  };

  const mockNetwork = {
    connect: mock(() => Promise.resolve()),
  };

  return {
    getContainer: mock(() => mockContainer),
    pull: mock((_image: string, cb: (err: Error | null, stream: NodeJS.ReadableStream) => void) => {
      cb(null, {} as NodeJS.ReadableStream);
      return null;
    }),
    modem: {
      followProgress: mock((_stream: unknown, cb: (err: Error | null) => void) => cb(null)),
    },
    createContainer: mock(() => Promise.resolve(mockContainer)),
    getNetwork: mock(() => mockNetwork),
    _container: mockContainer,
    _network: mockNetwork,
  };
}

/** Drain the microtask queue several times to let the async IIFE progress. */
async function drainMicrotasks(iterations = 10) {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
}

describe('handleAgentUpdate', () => {
  test('returns 503 when docker is null', async () => {
    const res = await handleAgentUpdate(null as unknown as Dockerode, 'hlm-agent');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('Docker capability not enabled');
  });

  test('returns 202 before any Docker ops execute', async () => {
    const mockDocker = createMockDocker();
    // Make inspect never resolve so we can confirm 202 comes back immediately
    mockDocker._container.inspect = mock(() => new Promise(() => {}));
    mockDocker.getContainer = mock(() => mockDocker._container);

    const res = await handleAgentUpdate(mockDocker as unknown as Dockerode, 'hlm-agent');
    expect(res.status).toBe(202);
  });

  test('fires full async sequence: inspect → pull → stop → remove → create → start', async () => {
    const mockDocker = createMockDocker();

    const res = await handleAgentUpdate(mockDocker as unknown as Dockerode, 'hlm-agent');
    expect(res.status).toBe(202);

    await drainMicrotasks();

    expect(mockDocker.getContainer.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(mockDocker._container.inspect).toHaveBeenCalled();
    expect(mockDocker.pull).toHaveBeenCalledWith(
      'ghcr.io/homelab-manager/agent:latest',
      expect.any(Function)
    );
    expect(mockDocker._container.stop).toHaveBeenCalled();
    expect(mockDocker._container.remove).toHaveBeenCalled();
    expect(mockDocker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({ Image: 'ghcr.io/homelab-manager/agent:latest' })
    );
    expect(mockDocker._container.start).toHaveBeenCalled();
  });

  test('connects additional networks after start, skipping NetworkMode network', async () => {
    const mockDocker = createMockDocker();
    // Override inspect to return multiple networks
    mockDocker._container.inspect = mock(() =>
      Promise.resolve({
        Image: 'ghcr.io/homelab-manager/agent:latest',
        Config: {
          Env: ['AGENT_TOKEN=abc'],
          ExposedPorts: { '9090/tcp': {} },
        },
        HostConfig: {
          Binds: ['/var/run/docker.sock:/var/run/docker.sock'],
          PortBindings: { '9090/tcp': [{ HostPort: '9090' }] },
          RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
          NetworkMode: 'bridge',
        },
        NetworkSettings: {
          Networks: { bridge: {}, 'custom-net': {} },
        },
      })
    );
    mockDocker.getContainer = mock(() => mockDocker._container);

    const res = await handleAgentUpdate(mockDocker as unknown as Dockerode, 'hlm-agent');
    expect(res.status).toBe(202);

    await drainMicrotasks();

    // Should connect 'custom-net' but NOT 'bridge' (the NetworkMode)
    expect(mockDocker.getNetwork).toHaveBeenCalledWith('custom-net');
    expect(mockDocker._network.connect).toHaveBeenCalledWith({ Container: 'new-container-id' });

    const networkCalls = (mockDocker.getNetwork.mock.calls as string[][]).map(([name]) => name);
    expect(networkCalls).not.toContain('bridge');
  });

  test('logs error without throwing when async step fails', async () => {
    const mockDocker = createMockDocker();
    mockDocker._container.inspect = mock(() => Promise.reject(new Error('inspect failed')));
    mockDocker.getContainer = mock(() => mockDocker._container);

    const errorSpy = spyOn(console, 'error');

    const res = await handleAgentUpdate(mockDocker as unknown as Dockerode, 'hlm-agent');
    expect(res.status).toBe(202);

    await drainMicrotasks();

    expect(errorSpy).toHaveBeenCalled();
  });
});

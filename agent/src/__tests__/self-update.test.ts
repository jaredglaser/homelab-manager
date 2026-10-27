import { describe, expect, test, mock, beforeAll, afterEach } from 'bun:test';
import Dockerode from 'dockerode';
import { deriveHealthWaitParams, runAgentHandover, spawnUpdateHelper } from '../lib/self-update';

beforeAll(() => {
  console.error = mock(() => {});
  console.info = mock(() => {});
});

const TARGET = 'ghcr.io/jaredglaser/homelab-manager-agent@sha256:' + 'a'.repeat(64);
const PREVIOUS_DIGEST_REF = 'ghcr.io/jaredglaser/homelab-manager-agent@sha256:' + 'b'.repeat(64);

interface HandoverCapture {
  pulled: string[];
  stopped: boolean;
  removed: boolean;
  created: Record<string, unknown>[];
  started: number;
  stopError?: Error;
}

interface InspectState {
  healthStatus?: string;
  running?: boolean;
}

function handoverDocker(capture: HandoverCapture, inspectState: InspectState = {}) {
  const agent = {
    inspect: mock(() =>
      Promise.resolve({
        Name: '/hlm-agent',
        Image: 'sha256:' + '1'.repeat(64),
        Config: {
          Env: ['AGENT_VERSION=0.1.0', 'AGENT_HOST_NAME=test-host'],
          Cmd: undefined,
          Entrypoint: undefined,
          ExposedPorts: undefined,
          Labels: { 'hlm.managed': 'true' },
        },
        HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
        NetworkSettings: { Networks: { 'agent-internal': { Aliases: ['hlm-agent'], IPAddress: '172.20.0.5' } } },
      }),
    ),
    stop: mock(() => {
      capture.stopped = true;
      return capture.stopError ? Promise.reject(capture.stopError) : Promise.resolve();
    }),
    remove: mock(() => {
      capture.removed = true;
      return Promise.resolve();
    }),
  };
  return {
    getContainer: mock((_name: string) => agent),
    getImage: mock((_id: string) => ({
      inspect: mock(() =>
        Promise.resolve({
          RepoDigests: [_id === TARGET ? [] : [PREVIOUS_DIGEST_REF]].flat(),
          Config: { Healthcheck: undefined },
        }),
      ),
    })),
    pull: mock((image: string, cb: (err: Error | null, stream: unknown) => void) => {
      capture.pulled.push(image);
      cb(null, {});
    }),
    modem: { followProgress: mock((_stream: unknown, cb: (err: Error | null) => void) => cb(null)) },
    createContainer: mock((options: Record<string, unknown>) => {
      capture.created.push(options);
      return Promise.resolve({
        start: mock(() => {
          capture.started += 1;
          return Promise.resolve();
        }),
        stop: mock(() => Promise.resolve()),
        remove: mock(() => Promise.resolve()),
        inspect: mock(() =>
          Promise.resolve({
            State: { Running: inspectState.running ?? true, Health: inspectState.healthStatus ? { Status: inspectState.healthStatus } : undefined },
            NetworkSettings: { Networks: { 'agent-internal': { IPAddress: '172.20.0.9' } } },
          }),
        ),
      });
    }),
  } as never as Dockerode;
}

function withFetchOk(impl: () => Promise<Response>): { restore: () => void } {
  const original = globalThis.fetch;
  globalThis.fetch = mock(impl) as unknown as typeof fetch;
  return { restore: () => { globalThis.fetch = original; } };
}

afterEach(() => {
  resetFetch();
});

let fetchRestore: (() => void) | null = null;
function resetFetch() {
  if (fetchRestore) {
    fetchRestore();
    fetchRestore = null;
  }
}

describe('deriveHealthWaitParams', () => {
  test('uses the fixed default window when the image has no healthcheck', () => {
    expect(deriveHealthWaitParams(undefined)).toEqual({ maxAttempts: 10, intervalMs: 3000 });
  });

  test('derives the window from the healthcheck interval, start period, and retries', () => {
    const wait = deriveHealthWaitParams({ Interval: 30_000_000_000, StartPeriod: 0, Retries: 3 });
    // 30s interval * 4 + 10s slack, polled at min(3s, interval).
    expect(wait).toEqual({ maxAttempts: Math.ceil(130_000 / 3000), intervalMs: 3000 });
  });

  test('caps the poll at a 3s interval for slow healthchecks and defaults retries', () => {
    const wait = deriveHealthWaitParams({ Interval: 60_000_000_000, StartPeriod: 5_000_000_000 });
    expect(wait.intervalMs).toBe(3000);
    expect(wait.maxAttempts).toBe(Math.ceil((5_000 + 60_000 * 4 + 10_000) / 3000));
  });
});

describe('runAgentHandover', () => {
  test('pulls the target, swaps the container, and keeps the config', async () => {
    const capture: HandoverCapture = { pulled: [], stopped: false, removed: false, created: [], started: 0 };
    const docker = handoverDocker(capture);
    const fetch = withFetchOk(() => Promise.resolve(new Response(null, { status: 200 })));
    fetchRestore = fetch.restore;

    const result = await runAgentHandover(docker, { containerName: 'hlm-agent', targetImage: TARGET, agentPort: 9090 });

    expect(result).toEqual({ previousImage: PREVIOUS_DIGEST_REF, newImage: TARGET, rolledBack: false });
    expect(capture.pulled).toEqual([TARGET]);
    expect(capture.created).toHaveLength(1);
    expect(capture.created[0]).toMatchObject({
      name: 'hlm-agent',
      Image: TARGET,
      HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
      Labels: { 'hlm.managed': 'true' },
    });
    expect((capture.created[0] as { Env?: string[] }).Env).toEqual(['AGENT_HOST_NAME=test-host']);
    expect(capture.started).toBe(1);
    // The old agent container must actually go away before the replacement takes its name and port.
    expect(capture.stopped).toBe(true);
  });

  test('rolls back to the previous digest ref when the replacement is unhealthy', async () => {
    const capture: HandoverCapture = { pulled: [], stopped: false, removed: false, created: [], started: 0 };
    const docker = handoverDocker(capture, { healthStatus: 'unhealthy' });

    const result = await runAgentHandover(docker, { containerName: 'hlm-agent', targetImage: TARGET, agentPort: 9090 });

    expect(result.rolledBack).toBe(true);
    expect(capture.created).toHaveLength(2);
    expect((capture.created[1] as { Image?: string }).Image).toBe(PREVIOUS_DIGEST_REF);
    expect(capture.started).toBe(2);
  });

  test('verifies a healthcheck-less image over the internal /health endpoint', async () => {
    const capture: HandoverCapture = { pulled: [], stopped: false, removed: false, created: [], started: 0 };
    const docker = handoverDocker(capture, { running: true });
    const fetch = withFetchOk(() => Promise.resolve(new Response(null, { status: 200 })));
    fetchRestore = fetch.restore;

    const result = await runAgentHandover(docker, { containerName: 'hlm-agent', targetImage: TARGET, agentPort: 9090 });

    expect(result.rolledBack).toBe(false);
    expect(capture.started).toBe(1);
  });

  test('throws without touching the running container when the pull fails', async () => {
    const capture: HandoverCapture = { pulled: [], stopped: false, removed: false, created: [], started: 0 };
    const docker = handoverDocker(capture);
    (docker.pull as unknown as ReturnType<typeof mock>).mockImplementation(
      (_image: string, cb: (err: Error | null) => void) => cb(new Error('manifest unknown')),
    );

    await expect(
      runAgentHandover(docker, { containerName: 'hlm-agent', targetImage: TARGET, agentPort: 9090 }),
    ).rejects.toThrow('manifest unknown');
    expect(capture.created).toHaveLength(0);
    expect(capture.started).toBe(0);
  });

  test('rolls back when the replacement fails to start', async () => {
    const capture: HandoverCapture = { pulled: [], stopped: false, removed: false, created: [], started: 0 };
    const docker = handoverDocker(capture);
    // First create is the replacement: its start fails. Second create is the rollback.
    let createCount = 0;
    (docker.createContainer as unknown as ReturnType<typeof mock>).mockImplementation((options: Record<string, unknown>) => {
      createCount += 1;
      capture.created.push(options);
      if (createCount === 1) {
        return Promise.resolve({
          start: mock(() => Promise.reject(new Error('port is already allocated'))),
          stop: mock(() => Promise.resolve()),
          remove: mock(() => Promise.resolve()),
        });
      }
      return Promise.resolve({ start: mock(() => Promise.resolve()) });
    });

    const result = await runAgentHandover(docker, { containerName: 'hlm-agent', targetImage: TARGET, agentPort: 9090 });

    expect(result.rolledBack).toBe(true);
    expect((capture.created[1] as { Image?: string }).Image).toBe(PREVIOUS_DIGEST_REF);
  });
});

describe('spawnUpdateHelper', () => {
  test('creates and starts a one-shot helper from the agent image without aliases', async () => {
    const endpoints: Record<string, unknown> = {};
    const docker = {
      getContainer: mock((_name: string) => ({
        inspect: mock(() =>
          Promise.resolve({
            Image: 'sha256:' + '1'.repeat(64),
            NetworkSettings: {
              Networks: {
                'agent-internal': { Aliases: ['hlm-agent'], IPAddress: '172.20.0.5' },
                'agent-public': { Aliases: ['hlm-agent'], IPAddress: '172.21.0.5' },
              },
            },
          }),
        ),
      })),
      createContainer: mock((options: Record<string, unknown>) => {
        Object.assign(endpoints, (options as { NetworkingConfig: { EndpointsConfig: Record<string, unknown> } }).NetworkingConfig.EndpointsConfig);
        return Promise.resolve({ start: mock(() => Promise.resolve()) });
      }),
    } as never as Dockerode;

    const helper = await spawnUpdateHelper(docker, {
      containerName: 'hlm-agent',
      targetImage: TARGET,
      agentPort: 9090,
      dockerHost: 'tcp://socket-proxy:2375',
    });

    expect(helper).toBeDefined();
    expect(endpoints['agent-internal']).toEqual({});
    expect(endpoints['agent-public']).toEqual({});
  });
});

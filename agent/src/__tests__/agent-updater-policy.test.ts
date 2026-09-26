import { describe, expect, test, mock, beforeAll } from 'bun:test';
import { handleAgentUpdaterPolicy, parseUpdaterPolicyRequest } from '../routes/agent-updater-policy';

beforeAll(() => {
  console.info = mock(() => {});
  console.error = mock(() => {});
});

function makeUpdaterInfo(overrides: Record<string, unknown> = {}) {
  return {
    State: { Running: true },
    Config: {
      Image: 'ghcr.io/org/agent-updater:latest',
      Env: ['HLM_WATCH_CONTAINER=hlm-agent', 'HLM_AUTO_UPDATE=false', 'HLM_TRIGGER_PORT=9091'],
      Cmd: null,
      Entrypoint: null,
      ExposedPorts: { '9091/tcp': {} },
      Labels: { 'hlm.role': 'agent-updater' },
    },
    HostConfig: { Binds: ['/var/run/docker.sock:/var/run/docker.sock'] },
    ...overrides,
  };
}

interface MockContainer {
  inspect: ReturnType<typeof mock>;
  stop: ReturnType<typeof mock>;
  remove: ReturnType<typeof mock>;
}

function makeMockDocker(info: Record<string, unknown> | null) {
  const containers: Record<string, MockContainer> = {};
  const created: Record<string, unknown>[] = [];

  const mockContainer: MockContainer = {
    inspect: mock(() => (info === null ? Promise.reject({ statusCode: 404 }) : Promise.resolve(info))),
    stop: mock(() => Promise.resolve()),
    remove: mock(() => Promise.resolve()),
  };
  containers['hlm-agent-updater'] = mockContainer;

  const docker = {
    getContainer: mock((name: string) => {
      const existing = containers[name];
      if (existing) return existing;
      const createdContainer: MockContainer = {
        inspect: mock(() => Promise.resolve({})),
        stop: mock(() => Promise.resolve()),
        remove: mock(() => Promise.resolve()),
      };
      containers[name] = createdContainer;
      return createdContainer;
    }),
    createContainer: mock((opts: Record<string, unknown>) => {
      created.push(opts);
      return Promise.resolve({ start: mock(() => Promise.resolve()), id: 'new-id' });
    }),
  };
  return { docker, mockContainer, created };
}

describe('handleAgentUpdaterPolicy', () => {
  test('returns 503 when Docker capability is not enabled', async () => {
    const response = await handleAgentUpdaterPolicy(null, true);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe('Docker capability not enabled');
  });

  test('reports reconfigured false when the updater container does not exist', async () => {
    const { docker } = makeMockDocker(null);
    const response = await handleAgentUpdaterPolicy(docker as never, true);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.reconfigured).toBe(false);
    expect(body.reason).toContain('nothing to auto-update');
  });

  test('recreates the updater with autoUpdate true, preserving all other config', async () => {
    const { docker, mockContainer, created } = makeMockDocker(makeUpdaterInfo());
    const response = await handleAgentUpdaterPolicy(docker as never, true);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.reconfigured).toBe(true);
    expect(body.autoUpdate).toBe(true);

    expect(mockContainer.stop).toHaveBeenCalledTimes(1);
    expect(mockContainer.remove).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);

    const opts = created[0] as { name: string; Image: string; Env: string[]; HostConfig: unknown };
    expect(opts.name).toBe('hlm-agent-updater');
    expect(opts.Image).toBe('ghcr.io/org/agent-updater:latest');
    expect(opts.HostConfig).toEqual({ Binds: ['/var/run/docker.sock:/var/run/docker.sock'] });
    expect(opts.Env).toContain('HLM_AUTO_UPDATE=true');
    expect(opts.Env).toContain('HLM_WATCH_CONTAINER=hlm-agent');
    expect(opts.Env).toContain('HLM_TRIGGER_PORT=9091');
    expect(opts.Env.filter((e) => e.startsWith('HLM_AUTO_UPDATE='))).toHaveLength(1);
  });

  test('recreates the updater with autoUpdate false when opting out', async () => {
    const info = makeUpdaterInfo({ Config: { ...makeUpdaterInfo().Config, Env: ['HLM_AUTO_UPDATE=true'] } });
    const { docker, created } = makeMockDocker(info);
    const response = await handleAgentUpdaterPolicy(docker as never, false);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.reconfigured).toBe(true);
    expect(body.autoUpdate).toBe(false);
    expect((created[0] as { Env: string[] }).Env).toEqual(['HLM_AUTO_UPDATE=false']);
  });

  test('returns 500 when recreation fails', async () => {
    const { docker } = makeMockDocker(makeUpdaterInfo());
    (docker as { createContainer: ReturnType<typeof mock> }).createContainer = mock(() =>
      Promise.reject(new Error('no space left on device'))
    );
    const response = await handleAgentUpdaterPolicy(docker as never, true);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.reconfigured).toBe(false);
    expect(body.reason).toBe('no space left on device');
  });

  test('returns 500 when inspect fails with an unexpected error', async () => {
    const docker = {
      getContainer: mock(() => ({
        inspect: mock(() => Promise.reject(new Error('docker daemon down'))),
      })),
    };
    const response = await handleAgentUpdaterPolicy(docker as never, true);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.reconfigured).toBe(false);
    expect(body.reason).toBe('docker daemon down');
  });
});

describe('parseUpdaterPolicyRequest', () => {
  test('accepts a boolean autoUpdate', async () => {
    const parsed = await parseUpdaterPolicyRequest(
      new Request('http://localhost/agent/updater-policy', {
        method: 'POST',
        body: JSON.stringify({ autoUpdate: true }),
      })
    );
    expect(parsed).toEqual({ autoUpdate: true });
  });

  test('rejects invalid JSON', async () => {
    const parsed = await parseUpdaterPolicyRequest(
      new Request('http://localhost/agent/updater-policy', { method: 'POST', body: 'not json' })
    );
    expect(parsed).toBeInstanceOf(Response);
    expect((parsed as Response).status).toBe(400);
  });

  test('rejects non-boolean autoUpdate', async () => {
    const parsed = await parseUpdaterPolicyRequest(
      new Request('http://localhost/agent/updater-policy', {
        method: 'POST',
        body: JSON.stringify({ autoUpdate: 'true' }),
      })
    );
    expect(parsed).toBeInstanceOf(Response);
    expect((parsed as Response).status).toBe(400);
  });

  test('rejects a body without autoUpdate', async () => {
    const parsed = await parseUpdaterPolicyRequest(
      new Request('http://localhost/agent/updater-policy', {
        method: 'POST',
        body: JSON.stringify({}),
      })
    );
    expect(parsed).toBeInstanceOf(Response);
    expect((parsed as Response).status).toBe(400);
  });
});

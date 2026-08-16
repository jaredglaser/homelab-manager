import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import type { Pool } from 'pg';
import { BaseCollector } from '../collectors/base-collector';

// Suppress console output during tests
const originalConsoleLog = console.log;
const originalConsoleInfo = console.info;
const originalConsoleError = console.error;

function createMockDb() {
  return {
    id: 'test',
    getPool: () => ({}) as unknown as Pool,
    connect: mock(async () => {}),
    isConnected: () => true,
    close: mock(async () => {}),
  };
}

/** Extract first argument from each console.info mock call */
function getMockInfoCalls(): unknown[] {
  const mockFn = console.info as unknown as { mock: { calls: unknown[][] } };
  return mockFn.mock.calls.map((c) => c[0]);
}

function createWorkerConfig(overrides?: Partial<WorkerConfig>): WorkerConfig {
  return {
    docker: { enabled: false },
    zfs: { enabled: false },
    proxmox: { enabled: false },
    collection: { interval: 1000 },
    ...overrides,
  };
}

// Store original env to restore
const originalEnv = { ...process.env };

function clearZFSEnv() {
  Object.keys(process.env).forEach((key) => {
    if (key.startsWith('ZFS_HOST')) delete process.env[key];
  });
}

function clearProxmoxEnv() {
  Object.keys(process.env).forEach((key) => {
    if (key.startsWith('PROXMOX_')) delete process.env[key];
  });
}

function restoreEnv() {
  clearZFSEnv();
  clearProxmoxEnv();
  Object.assign(process.env, originalEnv);
}

describe('resolveAgentUrl', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.WORKER_LOCALHOST_AGENT;
    delete process.env.WORKER_LOCALHOST_AGENT;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.WORKER_LOCALHOST_AGENT;
    } else {
      process.env.WORKER_LOCALHOST_AGENT = savedEnv;
    }
  });

  it('returns url unchanged when WORKER_LOCALHOST_AGENT is not set', async () => {
    const { resolveAgentUrl } = await import('../collector-factory');
    expect(resolveAgentUrl('http://192.168.1.50:9090')).toBe('http://192.168.1.50:9090');
    expect(resolveAgentUrl('http://localhost:9090')).toBe('http://localhost:9090');
  });

  it('replaces localhost with docker host', async () => {
    process.env.WORKER_LOCALHOST_AGENT = 'hlm-agent';
    const { resolveAgentUrl } = await import('../collector-factory');
    expect(resolveAgentUrl('http://localhost:9090')).toBe('http://hlm-agent:9090');
    expect(resolveAgentUrl('http://127.0.0.1:9090')).toBe('http://hlm-agent:9090');
    expect(resolveAgentUrl('http://192.168.1.50:9090')).toBe('http://192.168.1.50:9090');
  });
});

describe('createCollectors', () => {
  let db: ReturnType<typeof createMockDb>;

  let runSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    db = createMockDb();
    console.log = mock(() => {});
    console.info = mock(() => {});
    console.error = mock(() => {});
    // Prevent collectors from actually running (and making real network calls)
    runSpy = spyOn(BaseCollector.prototype, 'run').mockResolvedValue(undefined);
    clearZFSEnv();
    clearProxmoxEnv();
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.info = originalConsoleInfo;
    console.error = originalConsoleError;
    runSpy.mockRestore();
    restoreEnv();
  });

  it('should return empty collectors when all env-configured collectors are disabled', async () => {
    const { createCollectors } = await import('../collector-factory');
    const controller = new AbortController();
    await using stack = new AsyncDisposableStack();

    const config = createWorkerConfig({ docker: { enabled: false }, zfs: { enabled: false }, proxmox: { enabled: false } });
    const { collectors, runners } = createCollectors(db as unknown as DatabaseClient, config, controller, stack);

    expect(collectors).toHaveLength(0);
    expect(runners).toHaveLength(0);

    controller.abort();
  });

  it('should not create any env-configured collectors for docker or zfs (managed-host-only)', async () => {
    const { createCollectors } = await import('../collector-factory');
    const controller = new AbortController();
    await using stack = new AsyncDisposableStack();

    const config = createWorkerConfig({ docker: { enabled: true }, zfs: { enabled: true } });
    const { collectors, runners } = createCollectors(db as unknown as DatabaseClient, config, controller, stack);

    // Docker and ZFS collectors are only created via createCollectorsForManagedHosts
    expect(collectors).toHaveLength(0);
    expect(runners).toHaveLength(0);

    controller.abort();
  });

  it('should log disabled message when proxmox is disabled', async () => {
    const { createCollectors } = await import('../collector-factory');
    const controller = new AbortController();
    await using stack = new AsyncDisposableStack();

    const config = createWorkerConfig({ proxmox: { enabled: false } });
    createCollectors(db as unknown as DatabaseClient, config, controller, stack);

    const logCalls = getMockInfoCalls();
    expect(logCalls).toContain('[Worker] Proxmox collector disabled');

    controller.abort();
  });

  it('should log "not configured" when proxmox enabled but no env vars', async () => {
    const { createCollectors } = await import('../collector-factory');
    const controller = new AbortController();
    await using stack = new AsyncDisposableStack();

    const config = createWorkerConfig({ proxmox: { enabled: true } });
    const { collectors, runners } = createCollectors(db as unknown as DatabaseClient, config, controller, stack);

    const logCalls = getMockInfoCalls();
    expect(logCalls).toContain('[Worker] Proxmox enabled but not configured');
    expect(collectors).toHaveLength(0);
    expect(runners).toHaveLength(0);

    controller.abort();
  });

  it('should create Proxmox collector when proxmox enabled and configured', async () => {
    process.env.PROXMOX_HOST = '192.168.1.200';
    process.env.PROXMOX_TOKEN_ID = 'root@pam!test';
    process.env.PROXMOX_TOKEN_SECRET = '12345678-1234-1234-1234-123456789012';

    const { createCollectors } = await import('../collector-factory');
    const controller = new AbortController();
    await using stack = new AsyncDisposableStack();

    const config = createWorkerConfig({ proxmox: { enabled: true } });
    const { collectors, runners } = createCollectors(db as unknown as DatabaseClient, config, controller, stack);

    expect(collectors).toHaveLength(1);
    expect(runners).toHaveLength(1);
    expect(collectors[0].name).toBe('ProxmoxCollector[192.168.1.200]');

    controller.abort();
  });

});

describe('loadHermesEnvConfig', () => {
  const HERMES_ENV_KEYS = [
    'HERMES_GATEWAY_URL',
    'HERMES_DASHBOARD_BASE_URL',
    'HERMES_MAX_IN_FLIGHT',
    'HERMES_MAX_DAILY_RUNS',
    'HERMES_MAX_DAILY_PAGES',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of HERMES_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of HERMES_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('defaults to empty urls and DEFAULT_CEILINGS', async () => {
    const { loadHermesEnvConfig } = await import('../collector-factory');
    expect(loadHermesEnvConfig()).toEqual({
      gatewayUrl: '',
      dashboardBaseUrl: '',
      ceilings: { maxInFlight: 8, maxDailyRuns: 300, maxDailyPages: 200 },
    });
  });

  it('reads overrides from env', async () => {
    process.env.HERMES_GATEWAY_URL = 'https://gw.example';
    process.env.HERMES_DASHBOARD_BASE_URL = 'https://dash.example';
    process.env.HERMES_MAX_IN_FLIGHT = '4';
    process.env.HERMES_MAX_DAILY_RUNS = '50';
    process.env.HERMES_MAX_DAILY_PAGES = '10';

    const { loadHermesEnvConfig } = await import('../collector-factory');
    expect(loadHermesEnvConfig()).toEqual({
      gatewayUrl: 'https://gw.example',
      dashboardBaseUrl: 'https://dash.example',
      ceilings: { maxInFlight: 4, maxDailyRuns: 50, maxDailyPages: 10 },
    });
  });

  it('falls back to defaults on invalid or non-positive overrides', async () => {
    process.env.HERMES_MAX_IN_FLIGHT = 'not-a-number';
    process.env.HERMES_MAX_DAILY_RUNS = '0';
    process.env.HERMES_MAX_DAILY_PAGES = '-5';

    const { loadHermesEnvConfig } = await import('../collector-factory');
    expect(loadHermesEnvConfig().ceilings).toEqual({ maxInFlight: 8, maxDailyRuns: 300, maxDailyPages: 200 });
  });
});

describe('createHermesConfigProvider', () => {
  it('returns the decrypted secret alongside the env-sourced urls', async () => {
    const { createHermesConfigProvider } = await import('../collector-factory');
    const provider = createHermesConfigProvider(
      { get: async () => 'shh-secret' },
      { gatewayUrl: 'https://gw.example', dashboardBaseUrl: 'https://dash.example', ceilings: { maxInFlight: 1, maxDailyRuns: 1, maxDailyPages: 1 } },
    );

    expect(await provider()).toEqual({
      enabled: true,
      gatewayUrl: 'https://gw.example',
      secret: 'shh-secret',
      dashboardBaseUrl: 'https://dash.example',
    });
  });

  it('returns an empty secret when the lookup returns null', async () => {
    const { createHermesConfigProvider } = await import('../collector-factory');
    const provider = createHermesConfigProvider(
      { get: async () => null },
      { gatewayUrl: '', dashboardBaseUrl: '', ceilings: { maxInFlight: 1, maxDailyRuns: 1, maxDailyPages: 1 } },
    );

    expect((await provider()).secret).toBe('');
  });

  it('logs and returns an empty secret when the lookup throws', async () => {
    console.error = mock(() => {});
    const { createHermesConfigProvider } = await import('../collector-factory');
    const provider = createHermesConfigProvider(
      {
        get: async () => {
          throw new Error('decrypt failed');
        },
      },
      { gatewayUrl: '', dashboardBaseUrl: '', ceilings: { maxInFlight: 1, maxDailyRuns: 1, maxDailyPages: 1 } },
    );

    expect((await provider()).secret).toBe('');
    expect(console.error).toHaveBeenCalled();
    console.error = originalConsoleError;
  });
});

describe('InMemoryHermesBudgetStore', () => {
  it('loads zeroed buckets for an unseen day', async () => {
    const { InMemoryHermesBudgetStore } = await import('../collector-factory');
    const store = new InMemoryHermesBudgetStore();
    expect(await store.load('2026-08-16')).toEqual({ t0: 0, t1: 0, t2: 0, page: 0 });
  });

  it('increments a bucket and keeps days isolated', async () => {
    const { InMemoryHermesBudgetStore } = await import('../collector-factory');
    const store = new InMemoryHermesBudgetStore();
    await store.increment('2026-08-16', 't0', 2);
    await store.increment('2026-08-16', 't0', 1);
    await store.increment('2026-08-17', 'page', 5);

    expect(await store.load('2026-08-16')).toEqual({ t0: 3, t1: 0, t2: 0, page: 0 });
    expect(await store.load('2026-08-17')).toEqual({ t0: 0, t1: 0, t2: 0, page: 5 });
  });
});

describe('createHermesDispatcher', () => {
  const HERMES_ENV_KEYS = ['HERMES_PUSH_ENABLED', 'HERMES_MAX_IN_FLIGHT'] as const;
  const saved: Record<string, string | undefined> = {};
  let controller: AbortController;

  beforeEach(() => {
    for (const key of HERMES_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    controller = new AbortController();
  });

  afterEach(async () => {
    for (const key of HERMES_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    controller.abort();
  });

  it('returns null when HERMES_PUSH_ENABLED is unset', async () => {
    const { createHermesDispatcher } = await import('../collector-factory');
    expect(createHermesDispatcher({ get: async () => null }, controller.signal)).toBeNull();
  });

  it('returns null when HERMES_PUSH_ENABLED is not exactly "true"', async () => {
    process.env.HERMES_PUSH_ENABLED = 'false';
    const { createHermesDispatcher } = await import('../collector-factory');
    expect(createHermesDispatcher({ get: async () => null }, controller.signal)).toBeNull();
  });

  it('returns a dispatcher when the flag is "true"', async () => {
    process.env.HERMES_PUSH_ENABLED = 'true';
    const { createHermesDispatcher } = await import('../collector-factory');
    const dispatcher = createHermesDispatcher({ get: async () => 'secret' }, controller.signal);
    expect(dispatcher).not.toBeNull();
    await dispatcher?.[Symbol.asyncDispose]();
  });

  it('wires the ceilings override through to capacity()', async () => {
    process.env.HERMES_PUSH_ENABLED = 'true';
    process.env.HERMES_MAX_IN_FLIGHT = '3';
    const { createHermesDispatcher } = await import('../collector-factory');
    const dispatcher = createHermesDispatcher({ get: async () => null }, controller.signal);
    dispatcher?.setRunningContainerCount('host-a', 10_000);
    expect(dispatcher?.capacity().maxInFlight).toBe(3);
    await dispatcher?.[Symbol.asyncDispose]();
  });
});

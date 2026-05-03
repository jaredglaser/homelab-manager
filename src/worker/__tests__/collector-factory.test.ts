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
    enabled: true,
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

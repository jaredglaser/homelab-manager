import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import type { Pool } from 'pg';

// Suppress console output during tests
const originalConsoleLog = console.log;
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

/** Extract first argument from each console.log mock call */
function getMockLogCalls(): unknown[] {
  const mockFn = console.log as unknown as { mock: { calls: unknown[][] } };
  return mockFn.mock.calls.map((c) => c[0]);
}

function createWorkerConfig(overrides?: Partial<WorkerConfig>): WorkerConfig {
  return {
    enabled: true,
    docker: { enabled: false },
    zfs: { enabled: false },
    collection: { interval: 1000 },
    ...overrides,
  };
}

// Store original env to restore
const originalEnv = { ...process.env };

function clearDockerEnv() {
  Object.keys(process.env).forEach((key) => {
    if (key.startsWith('DOCKER_HOST')) delete process.env[key];
  });
}

function clearZFSEnv() {
  Object.keys(process.env).forEach((key) => {
    if (key.startsWith('ZFS_HOST')) delete process.env[key];
  });
}

function restoreEnv() {
  clearDockerEnv();
  clearZFSEnv();
  Object.assign(process.env, originalEnv);
}

describe('createCollectors', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    db = createMockDb();
    console.log = mock(() => {});
    console.error = mock(() => {});
    clearDockerEnv();
    clearZFSEnv();
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    restoreEnv();
  });

  it('should return empty collectors when both docker and zfs are disabled', async () => {
    const { createCollectors } = await import('../collector-factory');
    const controller = new AbortController();
    await using stack = new AsyncDisposableStack();

    const config = createWorkerConfig({ docker: { enabled: false }, zfs: { enabled: false } });
    const { collectors, runners } = createCollectors(db as unknown as DatabaseClient, config, controller, stack);

    expect(collectors).toHaveLength(0);
    expect(runners).toHaveLength(0);

    controller.abort();
  });

  it('should log disabled messages when collectors are disabled', async () => {
    const { createCollectors } = await import('../collector-factory');
    const controller = new AbortController();
    await using stack = new AsyncDisposableStack();

    const config = createWorkerConfig({ docker: { enabled: false }, zfs: { enabled: false } });
    createCollectors(db as unknown as DatabaseClient, config, controller, stack);

    const logCalls = getMockLogCalls();
    expect(logCalls).toContain('[Worker] Docker collector disabled');
    expect(logCalls).toContain('[Worker] ZFS collector disabled');

    controller.abort();
  });

  it('should log "no hosts" when docker enabled but no hosts configured', async () => {
    const { createCollectors } = await import('../collector-factory');
    const controller = new AbortController();
    await using stack = new AsyncDisposableStack();

    const config = createWorkerConfig({ docker: { enabled: true } });
    const { collectors, runners } = createCollectors(db as unknown as DatabaseClient, config, controller, stack);

    const logCalls = getMockLogCalls();
    expect(logCalls).toContain('[Worker] Docker enabled but no hosts configured');
    expect(collectors).toHaveLength(0);
    expect(runners).toHaveLength(0);

    controller.abort();
  });

  it('should create Docker collectors when docker enabled and hosts configured', async () => {
    process.env.DOCKER_HOST_1 = '192.168.1.100';
    process.env.DOCKER_HOST_NAME_1 = 'docker-host-1';

    const { createCollectors } = await import('../collector-factory');
    const controller = new AbortController();
    await using stack = new AsyncDisposableStack();

    const config = createWorkerConfig({ docker: { enabled: true } });
    const { collectors, runners } = createCollectors(db as unknown as DatabaseClient, config, controller, stack);

    expect(collectors).toHaveLength(1);
    expect(runners).toHaveLength(1);
    expect(collectors[0].name).toBe('DockerCollector[docker-host-1]');

    controller.abort();
  });

  it('should log "no hosts" when zfs enabled but no hosts configured', async () => {
    const { createCollectors } = await import('../collector-factory');
    const controller = new AbortController();
    await using stack = new AsyncDisposableStack();

    const config = createWorkerConfig({ zfs: { enabled: true } });
    const { collectors, runners } = createCollectors(db as unknown as DatabaseClient, config, controller, stack);

    const logCalls = getMockLogCalls();
    expect(logCalls).toContain('[Worker] ZFS enabled but no hosts configured');
    expect(collectors).toHaveLength(0);
    expect(runners).toHaveLength(0);

    controller.abort();
  });

  it('should create ZFS collectors when zfs enabled and hosts configured', async () => {
    process.env.ZFS_HOST_1 = '192.168.1.50';
    process.env.ZFS_HOST_USER_1 = 'root';
    process.env.ZFS_HOST_NAME_1 = 'zfs-host-1';
    process.env.ZFS_HOST_KEY_PATH_1 = '/keys/id_rsa';

    const { createCollectors } = await import('../collector-factory');
    const controller = new AbortController();
    await using stack = new AsyncDisposableStack();

    const config = createWorkerConfig({ zfs: { enabled: true } });
    const { collectors, runners } = createCollectors(db as unknown as DatabaseClient, config, controller, stack);

    expect(collectors).toHaveLength(1);
    expect(runners).toHaveLength(1);
    expect(collectors[0].name).toBe('ZFSCollector[zfs-host-1]');

    controller.abort();
  });

  it('should create both docker and zfs collectors when both enabled', async () => {
    process.env.DOCKER_HOST_1 = '192.168.1.100';
    process.env.DOCKER_HOST_NAME_1 = 'docker-1';
    process.env.ZFS_HOST_1 = '192.168.1.50';
    process.env.ZFS_HOST_USER_1 = 'root';
    process.env.ZFS_HOST_NAME_1 = 'zfs-1';
    process.env.ZFS_HOST_KEY_PATH_1 = '/keys/id_rsa';

    const { createCollectors } = await import('../collector-factory');
    const controller = new AbortController();
    await using stack = new AsyncDisposableStack();

    const config = createWorkerConfig({ docker: { enabled: true }, zfs: { enabled: true } });
    const { collectors, runners } = createCollectors(db as unknown as DatabaseClient, config, controller, stack);

    expect(collectors).toHaveLength(2);
    expect(runners).toHaveLength(2);

    controller.abort();
  });

  it('should create multiple docker collectors for multiple hosts', async () => {
    process.env.DOCKER_HOST_1 = '192.168.1.100';
    process.env.DOCKER_HOST_NAME_1 = 'host-a';
    process.env.DOCKER_HOST_2 = '192.168.1.101';
    process.env.DOCKER_HOST_NAME_2 = 'host-b';

    const { createCollectors } = await import('../collector-factory');
    const controller = new AbortController();
    await using stack = new AsyncDisposableStack();

    const config = createWorkerConfig({ docker: { enabled: true } });
    const { collectors, runners } = createCollectors(db as unknown as DatabaseClient, config, controller, stack);

    expect(collectors).toHaveLength(2);
    expect(runners).toHaveLength(2);

    controller.abort();
  });
});

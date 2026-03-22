import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';
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

function clearProxmoxEnv() {
  Object.keys(process.env).forEach((key) => {
    if (key.startsWith('PROXMOX_')) delete process.env[key];
  });
}

function restoreEnv() {
  clearDockerEnv();
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
    clearDockerEnv();
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

    const logCalls = getMockInfoCalls();
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

    const logCalls = getMockInfoCalls();
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

    const logCalls = getMockInfoCalls();
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

  it('should create all collectors when all enabled and configured', async () => {
    process.env.DOCKER_HOST_1 = '192.168.1.100';
    process.env.DOCKER_HOST_NAME_1 = 'docker-1';
    process.env.ZFS_HOST_1 = '192.168.1.50';
    process.env.ZFS_HOST_USER_1 = 'root';
    process.env.ZFS_HOST_NAME_1 = 'zfs-1';
    process.env.ZFS_HOST_KEY_PATH_1 = '/keys/id_rsa';
    process.env.PROXMOX_HOST = '192.168.1.200';
    process.env.PROXMOX_TOKEN_ID = 'root@pam!test';
    process.env.PROXMOX_TOKEN_SECRET = '12345678-1234-1234-1234-123456789012';

    const { createCollectors } = await import('../collector-factory');
    const controller = new AbortController();
    await using stack = new AsyncDisposableStack();

    const config = createWorkerConfig({
      docker: { enabled: true },
      zfs: { enabled: true },
      proxmox: { enabled: true },
    });
    const { collectors, runners } = createCollectors(db as unknown as DatabaseClient, config, controller, stack);

    expect(collectors).toHaveLength(3);
    expect(runners).toHaveLength(3);

    controller.abort();
  });
});

describe('createCollectorsForManagedHosts', () => {
  let db: ReturnType<typeof createMockDb>;
  let runSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    db = createMockDb();
    console.log = mock(() => {});
    console.info = mock(() => {});
    console.error = mock(() => {});
    runSpy = spyOn(BaseCollector.prototype, 'run').mockResolvedValue(undefined);
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.info = originalConsoleInfo;
    console.error = originalConsoleError;
    runSpy.mockRestore();
  });

  const sampleManagedHost: ManagedHost = {
    id: 1,
    name: 'homeserver',
    agent_url: 'http://192.168.1.10:9090',
    capabilities: { docker: true },
    agent_version: '0.1.0',
    status: 'healthy',
    created_at: new Date(),
    updated_at: new Date(),
  };

  it('creates AgentStatsCollector for each managed host when feature flag is on', async () => {
    const mockIsEnabled = mock(() => true);
    const mockFindAll = mock(async () => [sampleManagedHost]);
    const mockGetToken = mock(() => Promise.resolve('test-token'));

    const { createCollectorsForManagedHosts } = await import('../collector-factory');

    const shutdownController = new AbortController();
    await using stack = new AsyncDisposableStack();

    const workerConfig = createWorkerConfig({ docker: { enabled: true } });

    const result = await createCollectorsForManagedHosts(
      db as unknown as DatabaseClient, workerConfig, shutdownController, stack,
      mockIsEnabled, mockFindAll, mockGetToken,
    );

    expect(result.collectors).toHaveLength(1);
    expect(result.collectors[0].name).toBe('AgentStatsCollector[homeserver]');
    expect(result.runners).toHaveLength(1);
    expect(mockGetToken).toHaveBeenCalledWith('homeserver');

    shutdownController.abort();
  });

  it('returns empty when feature flag is off', async () => {
    const mockIsEnabled = mock(() => false);
    const mockFindAll = mock(async () => []);
    const mockGetToken = mock(() => Promise.resolve(null));

    const { createCollectorsForManagedHosts } = await import('../collector-factory');

    const shutdownController = new AbortController();
    await using stack = new AsyncDisposableStack();
    const workerConfig = createWorkerConfig({ docker: { enabled: true } });

    const result = await createCollectorsForManagedHosts(
      db as unknown as DatabaseClient, workerConfig, shutdownController, stack,
      mockIsEnabled, mockFindAll, mockGetToken,
    );

    expect(result.collectors).toHaveLength(0);
    expect(result.runners).toHaveLength(0);
    expect(mockFindAll).not.toHaveBeenCalled();

    shutdownController.abort();
  });

  it('returns empty when no managed hosts exist', async () => {
    const mockIsEnabled = mock(() => true);
    const mockFindAll = mock(async () => []);
    const mockGetToken = mock(() => Promise.resolve('test-token'));

    const { createCollectorsForManagedHosts } = await import('../collector-factory');

    const shutdownController = new AbortController();
    await using stack = new AsyncDisposableStack();
    const workerConfig = createWorkerConfig({ docker: { enabled: true } });

    const result = await createCollectorsForManagedHosts(
      db as unknown as DatabaseClient, workerConfig, shutdownController, stack,
      mockIsEnabled, mockFindAll, mockGetToken,
    );

    expect(result.collectors).toHaveLength(0);
    expect(result.runners).toHaveLength(0);
    expect(mockFindAll).toHaveBeenCalledTimes(1);

    shutdownController.abort();
  });

  it('skips managed host and continues when getToken throws', async () => {
    const host2: ManagedHost = { ...sampleManagedHost, id: 2, name: 'other-host', agent_url: 'http://192.168.1.11:9090' };
    const mockIsEnabled = mock(() => true);
    const mockFindAll = mock(async () => [sampleManagedHost, host2]);
    let callCount = 0;
    const mockGetToken = mock(async (hostname: string) => {
      callCount++;
      if (hostname === 'homeserver') throw new Error('OpenBao unreachable');
      return 'test-token';
    });

    const { createCollectorsForManagedHosts } = await import('../collector-factory');

    const shutdownController = new AbortController();
    await using stack = new AsyncDisposableStack();
    const workerConfig = createWorkerConfig({ docker: { enabled: true } });

    const result = await createCollectorsForManagedHosts(
      db as unknown as DatabaseClient, workerConfig, shutdownController, stack,
      mockIsEnabled, mockFindAll, mockGetToken,
    );

    expect(result.collectors).toHaveLength(1);
    expect(result.collectors[0].name).toBe('AgentStatsCollector[other-host]');
    expect(callCount).toBe(2);

    const errorCalls = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const tokenErrorCall = errorCalls.find((c) => String(c[0]).includes('Failed to retrieve token'));
    expect(tokenErrorCall).toBeDefined();

    shutdownController.abort();
  });

  it('skips managed hosts when OpenBao returns no token', async () => {
    const mockIsEnabled = mock(() => true);
    const mockFindAll = mock(async () => [sampleManagedHost]);
    const mockGetToken = mock(() => Promise.resolve(null));

    const { createCollectorsForManagedHosts } = await import('../collector-factory');

    const shutdownController = new AbortController();
    await using stack = new AsyncDisposableStack();
    const workerConfig = createWorkerConfig({ docker: { enabled: true } });

    const result = await createCollectorsForManagedHosts(
      db as unknown as DatabaseClient, workerConfig, shutdownController, stack,
      mockIsEnabled, mockFindAll, mockGetToken,
    );

    expect(result.collectors).toHaveLength(0);
    expect(mockGetToken).toHaveBeenCalledWith('homeserver');

    shutdownController.abort();
  });
});

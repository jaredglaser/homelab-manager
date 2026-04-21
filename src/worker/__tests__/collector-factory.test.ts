import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';
import type { Pool } from 'pg';
import { BaseCollector } from '../collectors/base-collector';
import { ContainerInventoryCollector } from '../collectors/container-inventory-collector';

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

/** Extract first argument from each console.error mock call */
function getMockErrorCalls(): unknown[] {
  const mockFn = console.error as unknown as { mock: { calls: unknown[][] } };
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
    agentUrl: 'http://192.168.1.10:9090',
    capabilities: { docker: true, zfs: true },
    agentVersion: '0.1.0',
    status: 'healthy',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('creates AgentStatsCollector for each managed host', async () => {
    const mockFindAll = mock(async () => [sampleManagedHost]);

    const { createCollectorsForManagedHosts } = await import('../collector-factory');

    const shutdownController = new AbortController();
    await using stack = new AsyncDisposableStack();

    const workerConfig = createWorkerConfig({ docker: { enabled: true } });

    const result = await createCollectorsForManagedHosts(
      db as unknown as DatabaseClient, workerConfig, shutdownController, stack,
      mockFindAll, async () => 'mock-token',
    );

    expect(result.collectors).toHaveLength(1);
    expect(result.collectors[0].name).toBe('AgentStatsCollector[homeserver]');
    expect(result.runners).toHaveLength(1);

    shutdownController.abort();
  });

  it('returns empty when no managed hosts exist', async () => {
    const mockFindAll = mock(async () => []);

    const { createCollectorsForManagedHosts } = await import('../collector-factory');

    const shutdownController = new AbortController();
    await using stack = new AsyncDisposableStack();
    const workerConfig = createWorkerConfig({ docker: { enabled: true } });

    const result = await createCollectorsForManagedHosts(
      db as unknown as DatabaseClient, workerConfig, shutdownController, stack,
      mockFindAll, async () => 'mock-token',
    );

    expect(result.collectors).toHaveLength(0);
    expect(result.runners).toHaveLength(0);
    expect(mockFindAll).toHaveBeenCalledTimes(1);

    shutdownController.abort();
  });

  it('skips managed host and continues when getToken throws', async () => {
    const host2: ManagedHost = { ...sampleManagedHost, id: 2, name: 'other-host', agentUrl: 'http://192.168.1.11:9090' };

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
      mockFindAll, mockGetToken,
    );

    expect(result.collectors).toHaveLength(1);
    expect(result.collectors[0].name).toBe('AgentStatsCollector[other-host]');
    expect(callCount).toBe(2);

    const errorCalls = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const tokenErrorCall = errorCalls.find((c) => String(c[0]).includes('Failed to retrieve token'));
    expect(tokenErrorCall).toBeDefined();

    shutdownController.abort();
  });

  it('returns empty when both docker and zfs collection are disabled', async () => {
    const mockFindAll = mock(async () => [sampleManagedHost]);

    const { createCollectorsForManagedHosts } = await import('../collector-factory');

    const shutdownController = new AbortController();
    await using stack = new AsyncDisposableStack();
    const workerConfig = createWorkerConfig({ docker: { enabled: false }, zfs: { enabled: false } });

    const result = await createCollectorsForManagedHosts(
      db as unknown as DatabaseClient, workerConfig, shutdownController, stack,
      mockFindAll, async () => 'mock-token',
    );

    expect(result.collectors).toHaveLength(0);
    expect(result.runners).toHaveLength(0);
    expect(mockFindAll).not.toHaveBeenCalled();

    shutdownController.abort();
  });

  it('creates only ZFSCollector when docker disabled but zfs enabled', async () => {
    const mockFindAll = mock(async () => [sampleManagedHost]);

    const { createCollectorsForManagedHosts } = await import('../collector-factory');

    const shutdownController = new AbortController();
    await using stack = new AsyncDisposableStack();
    const workerConfig = createWorkerConfig({ docker: { enabled: false }, zfs: { enabled: true } });

    const result = await createCollectorsForManagedHosts(
      db as unknown as DatabaseClient, workerConfig, shutdownController, stack,
      mockFindAll, async () => 'mock-token',
    );

    expect(result.collectors).toHaveLength(1);
    expect(result.collectors[0].name).toBe('ZFSCollector[homeserver]');
    expect(result.runners).toHaveLength(1);

    shutdownController.abort();
  });

  it('creates both AgentStatsCollector and ZFSCollector when both enabled', async () => {
    const mockFindAll = mock(async () => [sampleManagedHost]);

    const { createCollectorsForManagedHosts } = await import('../collector-factory');

    const shutdownController = new AbortController();
    await using stack = new AsyncDisposableStack();
    const workerConfig = createWorkerConfig({ docker: { enabled: true }, zfs: { enabled: true } });

    const result = await createCollectorsForManagedHosts(
      db as unknown as DatabaseClient, workerConfig, shutdownController, stack,
      mockFindAll, async () => 'mock-token',
    );

    expect(result.collectors).toHaveLength(2);
    const names = result.collectors.map(c => c.name);
    expect(names).toContain('AgentStatsCollector[homeserver]');
    expect(names).toContain('ZFSCollector[homeserver]');
    expect(result.runners).toHaveLength(2);

    shutdownController.abort();
  });

  it('skips managed hosts when getToken returns null', async () => {
    const mockFindAll = mock(async () => [sampleManagedHost]);

    const { createCollectorsForManagedHosts } = await import('../collector-factory');

    const shutdownController = new AbortController();
    await using stack = new AsyncDisposableStack();
    const workerConfig = createWorkerConfig({ docker: { enabled: true } });

    const result = await createCollectorsForManagedHosts(
      db as unknown as DatabaseClient, workerConfig, shutdownController, stack,
      mockFindAll, async () => null,
    );

    expect(result.collectors).toHaveLength(0);

    shutdownController.abort();
  });
});

describe('createContainerInventoryCollectors', () => {
  let db: ReturnType<typeof createMockDb>;
  let runSpy: ReturnType<typeof spyOn>;

  const dockerHost: ManagedHost = {
    id: 1,
    name: 'homeserver',
    agentUrl: 'http://192.168.1.10:9090',
    capabilities: { docker: true, zfs: true },
    agentVersion: '0.1.0',
    status: 'healthy',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const noDockerHost: ManagedHost = {
    ...dockerHost,
    id: 2,
    name: 'zfs-only',
    capabilities: { docker: false, zfs: true },
  };

  beforeEach(() => {
    db = createMockDb();
    console.log = mock(() => {});
    console.info = mock(() => {});
    console.error = mock(() => {});
    runSpy = spyOn(ContainerInventoryCollector.prototype, 'run').mockResolvedValue(undefined);
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.info = originalConsoleInfo;
    console.error = originalConsoleError;
    runSpy.mockRestore();
  });

  it('creates a ContainerInventoryCollector per managed host with capabilities.docker === true', async () => {
    const { createContainerInventoryCollectors } = await import('../collector-factory');

    const shutdownController = new AbortController();
    await using stack = new AsyncDisposableStack();

    const result = await createContainerInventoryCollectors(
      db as unknown as DatabaseClient,
      shutdownController,
      stack,
      async () => [dockerHost],
      async () => 'mock-token',
    );

    expect(result.runners).toHaveLength(1);
    expect(runSpy).toHaveBeenCalledTimes(1);

    shutdownController.abort();
  });

  it('returns empty runners when no hosts exist', async () => {
    const { createContainerInventoryCollectors } = await import('../collector-factory');

    const shutdownController = new AbortController();
    await using stack = new AsyncDisposableStack();

    const result = await createContainerInventoryCollectors(
      db as unknown as DatabaseClient,
      shutdownController,
      stack,
      async () => [],
      async () => 'mock-token',
    );

    expect(result.runners).toHaveLength(0);

    shutdownController.abort();
  });

  it('skips hosts where capabilities.docker === false and logs info', async () => {
    const { createContainerInventoryCollectors } = await import('../collector-factory');

    const shutdownController = new AbortController();
    await using stack = new AsyncDisposableStack();

    const result = await createContainerInventoryCollectors(
      db as unknown as DatabaseClient,
      shutdownController,
      stack,
      async () => [noDockerHost],
      async () => 'mock-token',
    );

    expect(result.runners).toHaveLength(0);
    const infoCalls = getMockInfoCalls();
    expect(infoCalls.some((m) => String(m).includes('Docker capability not enabled'))).toBe(true);

    shutdownController.abort();
  });

  it('skips hosts whose token lookup returns null and logs info', async () => {
    const { createContainerInventoryCollectors } = await import('../collector-factory');

    const shutdownController = new AbortController();
    await using stack = new AsyncDisposableStack();

    const result = await createContainerInventoryCollectors(
      db as unknown as DatabaseClient,
      shutdownController,
      stack,
      async () => [dockerHost],
      async () => null,
    );

    expect(result.runners).toHaveLength(0);
    const infoCalls = getMockInfoCalls();
    expect(infoCalls.some((m) => String(m).includes('no agent token in secret store'))).toBe(true);

    shutdownController.abort();
  });

  it('skips hosts whose token lookup throws, logs error, does not halt other hosts', async () => {
    const host2: ManagedHost = { ...dockerHost, id: 2, name: 'host2', agentUrl: 'http://192.168.1.11:9090' };
    const { createContainerInventoryCollectors } = await import('../collector-factory');

    const shutdownController = new AbortController();
    await using stack = new AsyncDisposableStack();

    let call = 0;
    const result = await createContainerInventoryCollectors(
      db as unknown as DatabaseClient,
      shutdownController,
      stack,
      async () => [dockerHost, host2],
      async (hostname) => {
        call++;
        if (hostname === 'homeserver') throw new Error('vault down');
        return 'good-token';
      },
    );

    // host2 succeeds, homeserver is skipped
    expect(result.runners).toHaveLength(1);
    expect(call).toBe(2);
    const errorCalls = getMockErrorCalls();
    expect(errorCalls.some((m) => String(m).includes('Failed to retrieve token'))).toBe(true);

    shutdownController.abort();
  });

  it('does not throw when multiple hosts are mixed (one succeeds, one skipped)', async () => {
    const { createContainerInventoryCollectors } = await import('../collector-factory');

    const shutdownController = new AbortController();
    await using stack = new AsyncDisposableStack();

    const result = await createContainerInventoryCollectors(
      db as unknown as DatabaseClient,
      shutdownController,
      stack,
      async () => [dockerHost, noDockerHost],
      async () => 'mock-token',
    );

    // dockerHost succeeds, noDockerHost is skipped
    expect(result.runners).toHaveLength(1);

    shutdownController.abort();
  });
});

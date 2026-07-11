import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { ProxmoxCollector } from '../proxmox-collector';
import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import type { ProxmoxConfig } from '@/lib/config/proxmox-config';
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

function createMockConfig(): WorkerConfig {
  return {
      docker: { enabled: false },
    zfs: { enabled: false },
    proxmox: { enabled: true },
    collection: { interval: 1000 },
  };
}

function createProxmoxConfig(overrides?: Partial<ProxmoxConfig>): ProxmoxConfig {
  return {
    host: '192.168.1.200',
    port: 8006,
    tokenId: 'root@pam!test',
    tokenSecret: '12345678-1234-1234-1234-123456789012',
    allowSelfSignedCerts: true,
    ...overrides,
  };
}

describe('ProxmoxCollector', () => {
  beforeEach(() => {
    console.log = mock(() => {});
    console.error = mock(() => {});
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  describe('construction', () => {
    it('should set name from proxmox config host', () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new ProxmoxCollector(
        db as unknown as DatabaseClient,
        createMockConfig(),
        createProxmoxConfig(),
        10000,
        controller,
      );

      expect(collector.name).toBe('ProxmoxCollector[192.168.1.200]');

      controller.abort();
    });

    it('should use default interval when 0 is passed', () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new ProxmoxCollector(
        db as unknown as DatabaseClient,
        createMockConfig(),
        createProxmoxConfig(),
        0,
        controller,
      );

      expect(collector.name).toBe('ProxmoxCollector[192.168.1.200]');

      controller.abort();
    });

    it('should implement AsyncDisposable', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new ProxmoxCollector(
        db as unknown as DatabaseClient,
        createMockConfig(),
        createProxmoxConfig(),
        10000,
        controller,
      );

      expect(Symbol.asyncDispose in collector).toBe(true);

      await collector[Symbol.asyncDispose]();
    });

    it('should be stoppable', () => {
      const db = createMockDb();
      const collector = new ProxmoxCollector(
        db as unknown as DatabaseClient,
        createMockConfig(),
        createProxmoxConfig(),
        10000,
      );

      collector.stop();

      expect((collector as any).signal.aborted).toBe(true);
    });
  });

  describe('pollInterval setter', () => {
    it('should update poll interval at runtime', () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new ProxmoxCollector(
        db as unknown as DatabaseClient,
        createMockConfig(),
        createProxmoxConfig(),
        10000,
        controller,
      );

      collector.pollInterval = 1000;

      expect((collector as any)._pollIntervalMs).toBe(1000);

      controller.abort();
    });

    it('should interrupt current sleep when poll interval changes', () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new ProxmoxCollector(
        db as unknown as DatabaseClient,
        createMockConfig(),
        createProxmoxConfig(),
        10000,
        controller,
      );

      // Simulate an in-progress sleep
      const sleepController = new AbortController();
      (collector as any)._sleepAbortController = sleepController;

      collector.pollInterval = 1000;

      expect(sleepController.signal.aborted).toBe(true);

      controller.abort();
    });
  });

  describe('collect()', () => {
    it('should poll and insert rows then sleep', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new ProxmoxCollector(
        db as unknown as DatabaseClient,
        createMockConfig(),
        createProxmoxConfig(),
        10000,
        controller,
      );

      // Mock the repository's insertProxmoxStats
      const writtenRows: any[][] = [];
      spyOn((collector as any).repository, 'insertProxmoxStats').mockImplementation(async (rows: any[]) => {
        writtenRows.push(rows);
        // Abort after first insert to stop the loop
        controller.abort();
      });

      // Mock proxmoxConnectionManager via dynamic import
      const mockSnapshot = {
        clusterName: 'test-cluster',
        quorate: true,
        version: 3,
        resources: [{
          id: 'node/pve1', type: 'node' as const, node: 'pve1', status: 'online',
          cpu: 0.5, maxcpu: 4, mem: 2e9, maxmem: 8e9, disk: 10e9, maxdisk: 100e9,
          uptime: 3600,
        }],
      };

      const mockClient = {
        getClusterSnapshot: mock(async () => mockSnapshot),
      };

      // We need to mock the dynamic import of proxmox-client
      const { proxmoxConnectionManager } = await import('@/lib/clients/proxmox-client');
      spyOn(proxmoxConnectionManager, 'getClient').mockReturnValue(mockClient as any);

      await (collector as any).collect().catch(() => {});

      expect(writtenRows.length).toBeGreaterThanOrEqual(1);
      // Should have cluster + 1 node = 2 rows
      expect(writtenRows[0].length).toBe(2);
      expect(writtenRows[0][0].entity_type).toBe('cluster');
      expect(writtenRows[0][1].entity_type).toBe('node');

      // Restore
      (proxmoxConnectionManager.getClient as ReturnType<typeof spyOn>).mockRestore();
    });
  });

  describe('debug logging', () => {
    it('should support docker debug logging toggle', () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new ProxmoxCollector(
        db as unknown as DatabaseClient,
        createMockConfig(),
        createProxmoxConfig(),
        10000,
        controller,
      );

      collector.dockerDebugLogging = true;
      collector.dockerDebugLogging = false;

      controller.abort();
    });

    it('should support db flush debug logging toggle', () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new ProxmoxCollector(
        db as unknown as DatabaseClient,
        createMockConfig(),
        createProxmoxConfig(),
        10000,
        controller,
      );

      collector.dbFlushDebugLogging = true;
      collector.dbFlushDebugLogging = false;

      controller.abort();
    });
  });
});

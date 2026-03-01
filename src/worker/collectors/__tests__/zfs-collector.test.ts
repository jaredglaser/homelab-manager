import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { Readable } from 'stream';
import { ZFSCollector } from '../zfs-collector';
import { sshConnectionManager } from '@/lib/clients/ssh-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import type { ZFSHostConfig } from '@/lib/config/zfs-config';

// Suppress console output during tests
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

function createMockDb() {
  return {
    id: 'test',
    getPool: () => ({} as any),
    connect: mock(async () => {}),
    isConnected: () => true,
    close: mock(async () => {}),
  };
}

function createMockConfig(): WorkerConfig {
  return {
    enabled: true,
    docker: { enabled: false },
    zfs: { enabled: true },
    collection: { interval: 1000 },
  };
}

function createHostConfig(overrides?: Partial<ZFSHostConfig>): ZFSHostConfig {
  return {
    host: '192.168.1.50',
    port: 22,
    name: 'test-zfs',
    username: 'root',
    privateKeyPath: '/keys/id_rsa',
    ...overrides,
  };
}

// Simulate zpool iostat -vvv output with pool, vdev, and disk hierarchy
const IOSTAT_OUTPUT = [
  '              capacity     operations     bandwidth',
  'pool        alloc   free   read  write   read  write',
  '----------  -----  -----  -----  -----  -----  -----',
  'tank        1.81T  2.19T     10     20   100K   200K',
  '  mirror-0      -      -      5     10    50K   100K',
  '    sda         -      -      3      5    25K    50K',
  '    sdb         -      -      2      5    25K    50K',
  '              capacity     operations     bandwidth',
].join('\n');

describe('ZFSCollector', () => {
  beforeEach(() => {
    console.log = mock(() => {});
    console.error = mock(() => {});
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  describe('construction', () => {
    it('should set name from host config', () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new ZFSCollector(db as any, createMockConfig(), createHostConfig(), controller);

      expect(collector.name).toBe('ZFSCollector[test-zfs]');

      controller.abort();
    });

    it('should set custom name from host config', () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new ZFSCollector(
        db as any,
        createMockConfig(),
        createHostConfig({ name: 'nas-server' }),
        controller,
      );

      expect(collector.name).toBe('ZFSCollector[nas-server]');

      controller.abort();
    });

    it('should implement AsyncDisposable', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new ZFSCollector(db as any, createMockConfig(), createHostConfig(), controller);

      expect(Symbol.asyncDispose in collector).toBe(true);

      await collector[Symbol.asyncDispose]();
    });

    it('should be stoppable', async () => {
      const db = createMockDb();
      const collector = new ZFSCollector(db as any, createMockConfig(), createHostConfig());

      collector.stop();

      expect((collector as any).signal.aborted).toBe(true);
    });
  });

  describe('collect()', () => {
    it('should throw when no SSH credentials configured', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const hostConfig = createHostConfig({
        privateKeyPath: undefined,
        password: undefined,
      });
      const collector = new ZFSCollector(db as any, createMockConfig(), hostConfig, controller);

      await expect((collector as any).collect()).rejects.toThrow(
        'No SSH credentials configured for host 192.168.1.50',
      );

      controller.abort();
    });

    it('should parse iostat output and write rows with correct hierarchy', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new ZFSCollector(db as any, createMockConfig(), createHostConfig(), controller);

      // Mock the repository's insertZFSStats to capture written rows
      const writtenRows: any[][] = [];
      spyOn((collector as any).repository, 'insertZFSStats').mockImplementation(async (rows: any[]) => {
        writtenRows.push(rows);
      });

      // Mock sshConnectionManager.getClient to return a fake SSH client
      const mockStream = Readable.from(IOSTAT_OUTPUT);
      const mockSSHClient = {
        exec: mock(async () => mockStream),
        isConnected: () => true,
        close: mock(async () => {}),
      };
      spyOn(sshConnectionManager, 'getClient').mockResolvedValue(mockSSHClient as any);

      await (collector as any).collect();

      // The second header line triggers a flush of the first cycle
      expect(writtenRows.length).toBe(1);
      const rows = writtenRows[0];

      // Should have 4 rows: pool + vdev + 2 disks
      expect(rows.length).toBe(4);

      // Pool row
      expect(rows[0].entity).toBe('tank');
      expect(rows[0].entity_type).toBe('pool');
      expect(rows[0].pool).toBe('tank');
      expect(rows[0].host).toBe('test-zfs');
      expect(rows[0].indent).toBe(0);

      // Vdev row
      expect(rows[1].entity).toBe('tank/mirror-0');
      expect(rows[1].entity_type).toBe('vdev');
      expect(rows[1].pool).toBe('tank');
      expect(rows[1].indent).toBe(2);

      // Disk rows
      expect(rows[2].entity).toBe('tank/mirror-0/sda');
      expect(rows[2].entity_type).toBe('disk');
      expect(rows[2].pool).toBe('tank');
      expect(rows[2].indent).toBe(4);

      expect(rows[3].entity).toBe('tank/mirror-0/sdb');
      expect(rows[3].entity_type).toBe('disk');

      controller.abort();
    });

    it('should write final cycle when stream ends without trailing header', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new ZFSCollector(db as any, createMockConfig(), createHostConfig(), controller);

      const writtenRows: any[][] = [];
      spyOn((collector as any).repository, 'insertZFSStats').mockImplementation(async (rows: any[]) => {
        writtenRows.push(rows);
      });

      // Output without a trailing header — only the final-cycle write path
      const output = [
        '              capacity     operations     bandwidth',
        'pool        alloc   free   read  write   read  write',
        '----------  -----  -----  -----  -----  -----  -----',
        'rpool       100G   900G      1      2    10K    20K',
      ].join('\n');

      const mockSSHClient = {
        exec: mock(async () => Readable.from(output)),
        isConnected: () => true,
        close: mock(async () => {}),
      };
      spyOn(sshConnectionManager, 'getClient').mockResolvedValue(mockSSHClient as any);

      await (collector as any).collect();

      // Final cycle should be written
      expect(writtenRows.length).toBe(1);
      expect(writtenRows[0].length).toBe(1);
      expect(writtenRows[0][0].entity).toBe('rpool');
      expect(writtenRows[0][0].entity_type).toBe('pool');

      controller.abort();
    });
  });

  describe('debug logging', () => {
    it('should support docker debug logging toggle', () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new ZFSCollector(db as any, createMockConfig(), createHostConfig(), controller);

      collector.dockerDebugLogging = true;
      collector.dockerDebugLogging = false;

      controller.abort();
    });

    it('should support db flush debug logging toggle', () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new ZFSCollector(db as any, createMockConfig(), createHostConfig(), controller);

      collector.dbFlushDebugLogging = true;
      collector.dbFlushDebugLogging = false;

      controller.abort();
    });
  });
});

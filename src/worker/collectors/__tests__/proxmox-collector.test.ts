import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { ProxmoxRequestError, type ProxmoxClient } from '@/lib/clients/proxmox-client';
import type { ProxmoxClusterSnapshot } from '@/types/proxmox';
import type { ProxmoxCollectorStateWrite } from '@/lib/database/repositories/proxmox-state-repository';
import type { NewProxmoxStat } from '@/lib/database/repositories/stats-repository';
import { ProxmoxCollector } from '../proxmox-collector';
import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import type { ProxmoxConnection } from '@/lib/config/proxmox-config';
import type { Pool } from 'pg';

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
    collection: { interval: 1000 },
    agents: { allowInsecurePlaintext: true },
  };
}

function createProxmoxConfig(overrides?: Partial<ProxmoxConnection>): ProxmoxConnection {
  return {
    id: 1,
    name: 'homelab',
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

      const mockSnapshot = {
        clusterName: 'test-cluster',
        quorate: true,
        version: 3,
        sampledAtMs: 0,
        resources: [{
          id: 'node/pve1', type: 'node' as const, node: 'pve1', status: 'online',
          cpu: 0.5, maxcpu: 4, mem: 2e9, maxmem: 8e9, disk: 10e9, maxdisk: 100e9,
          uptime: 3600,
        }],
      };

      const mockClient = {
        getClusterSnapshot: mock(async () => mockSnapshot),
      };
      const clientProvider = {
        getClient: mock(() => mockClient as unknown as ProxmoxClient),
      };

      const collector = new ProxmoxCollector(
        db as unknown as DatabaseClient,
        createMockConfig(),
        createProxmoxConfig(),
        10000,
        controller,
        clientProvider,
        { record: mock(async () => {}) },
      );

      const writtenRows: any[][] = [];
      spyOn((collector as any).repository, 'insertProxmoxStats').mockImplementation(async (rows: any[]) => {
        writtenRows.push(rows);
        // Abort after first insert to stop the loop
        controller.abort();
      });

      await (collector as any).collect().catch(() => {});

      expect(clientProvider.getClient).toHaveBeenCalledWith(createProxmoxConfig());
      expect(writtenRows.length).toBeGreaterThanOrEqual(1);
      // Should have cluster + 1 node = 2 rows
      expect(writtenRows[0].length).toBe(2);
      expect(writtenRows[0][0].entity_type).toBe('cluster');
      expect(writtenRows[0][1].entity_type).toBe('node');
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

  describe('recorded state', () => {
    const goodSnapshot: ProxmoxClusterSnapshot = {
      clusterName: 'c', quorate: true, version: 1, sampledAtMs: 0, resources: [],
    };
    let timeoutSpy: ReturnType<typeof spyOn>;
    let delays: number[] = [];

    beforeEach(() => {
      delays = [];
      timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        queueMicrotask(fn);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout);
    });

    afterEach(() => {
      timeoutSpy.mockRestore();
    });

    type Step = ProxmoxClusterSnapshot | Error;

    function setup(steps: Step[], options: { stopAfterInserts?: number; record?: (w: ProxmoxCollectorStateWrite) => Promise<void> } = {}) {
      const controller = new AbortController();
      const queue = [...steps];
      const getClusterSnapshot = mock(async () => {
        const step = queue.shift() ?? goodSnapshot;
        if (step instanceof Error) throw step;
        return step;
      });
      const writes: ProxmoxCollectorStateWrite[] = [];
      const record = mock(options.record ?? (async (write: ProxmoxCollectorStateWrite) => { writes.push(write); }));
      const collector = new ProxmoxCollector(
        createMockDb() as unknown as DatabaseClient,
        createMockConfig(),
        createProxmoxConfig({ host: 'pve.lan', port: 8006 }),
        1000,
        controller,
        { getClient: () => ({ getClusterSnapshot }) as unknown as ProxmoxClient },
        { record },
      );
      let inserts = 0;
      const inserted: NewProxmoxStat[][] = [];
      const insert = spyOn((collector as any).repository, 'insertProxmoxStats').mockImplementation(async (rows: NewProxmoxStat[]) => {
        inserted.push(rows);
        inserts++;
        if (inserts >= (options.stopAfterInserts ?? 1)) controller.abort();
      });
      return { collector, controller, getClusterSnapshot, writes, record, insert, inserted };
    }

    it('logs an unexpected response, records unreachable with its reason, and keeps polling until Proxmox answers', async () => {
      const shape = new ProxmoxRequestError('unreachable', '/cluster/resources', 'unexpected response shape: data invalid_type');
      const { collector, getClusterSnapshot, writes } = setup([shape, shape]);

      await collector.run();

      expect(getClusterSnapshot).toHaveBeenCalledTimes(3);
      const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
      expect(logged.some((line) => line.includes('code=unreachable') && line.includes('unexpected response shape'))).toBe(true);
      expect(writes.map((w) => [w.state, w.reason])).toEqual([
        ['unreachable', '/cluster/resources: unexpected response shape: data invalid_type'],
        ['collecting', null],
      ]);
      expect(writes[0]).toMatchObject({ connectionId: '1', host: 'pve.lan', port: 8006, lastSuccessAt: null });
      expect(writes[1].lastSuccessAt).toBeInstanceOf(Date);
    });

    it('records unreachable for a minute-long outage, then collecting on the first poll that succeeds', async () => {
      const down = new ProxmoxRequestError('unreachable', '/cluster/status', 'Connection refused');
      const { collector, writes } = setup([goodSnapshot, ...Array.from({ length: 6 }, () => down)], { stopAfterInserts: 2 });

      await collector.run();

      expect(writes.map((w) => w.state)).toEqual(['collecting', 'unreachable', 'collecting']);
      expect(writes[1].lastSuccessAt).toEqual(writes[0].lastSuccessAt);
    });

    it('writes an outage once, whichever of the two requests happens to fail first on each retry', async () => {
      const status = new ProxmoxRequestError('unreachable', '/cluster/status', 'Connection refused');
      const resources = new ProxmoxRequestError('unreachable', '/cluster/resources', 'Connection refused');
      const { collector, writes } = setup([status, resources, status, resources]);

      await collector.run();

      expect(writes.map((w) => w.state)).toEqual(['unreachable', 'collecting']);
    });

    it('backs off longer on each failed poll, and starts again from the base after a success', async () => {
      const down = new ProxmoxRequestError('unreachable', '/cluster/status', 'Connection refused');
      const { collector } = setup([down, down, down, down, goodSnapshot, down], { stopAfterInserts: 2 });

      await collector.run();

      const [first, second, third, fourth, pollSleep, afterSuccess] = delays;
      expect([first, second, third, fourth]).toEqual([1000, 2000, 4000, 8000]);
      expect(pollSleep).toBeLessThanOrEqual(1000);
      expect(afterSuccess).toBe(1000);
    });

    it('carries the rate tracker from one poll to the next, so the second point of a running guest has rates', async () => {
      const guestAt = (uptime: number, bytes: number): ProxmoxClusterSnapshot => ({
        clusterName: 'c', quorate: true, version: 1, sampledAtMs: uptime * 1000,
        resources: [{
          id: 'qemu/100', type: 'qemu', node: 'pve1', vmid: 100, status: 'running', uptime,
          netin: bytes, netout: bytes, diskread: bytes, diskwrite: bytes,
        }],
      });
      const { collector, inserted } = setup([guestAt(100, 1000), guestAt(110, 11_000)], { stopAfterInserts: 2 });

      await collector.run();

      const guestRows = inserted.map((rows) => rows.find((r) => r.entity_type === 'qemu')!);
      expect(guestRows[0].net_in_bytes_per_sec).toBeNull();
      expect(guestRows[1]).toMatchObject({
        net_in_bytes_per_sec: 1000,
        net_out_bytes_per_sec: 1000,
        disk_read_bytes_per_sec: 1000,
        disk_write_bytes_per_sec: 1000,
      });
    });

    it.each([
      ['token_rejected', new ProxmoxRequestError('token_rejected', '/cluster/status', 'HTTP 401')],
      ['certificate_refused', new ProxmoxRequestError('certificate_refused', '/cluster/status', 'self signed certificate')],
      ['unreachable', new TypeError('fetch is broken')],
    ] as const)('records %s and keeps polling', async (state, error) => {
      const { collector, writes, getClusterSnapshot } = setup([error]);

      await collector.run();

      expect(getClusterSnapshot).toHaveBeenCalledTimes(2);
      expect(writes.map((w) => w.state)).toEqual([state, 'collecting']);
    });

    it('writes collecting once while it lasts, and again after a minute to keep last_success_at fresh', async () => {
      const nowSpy = spyOn(Date, 'now');
      let now = 1_000_000;
      nowSpy.mockImplementation(() => now);
      try {
        const { collector, writes, insert } = setup([], { stopAfterInserts: 4 });
        insert.mockImplementation(async () => {
          now += 30_000;
          if (insert.mock.calls.length >= 4) (collector as any).abortController.abort();
        });

        await collector.run();

        expect(writes.map((w) => w.state)).toEqual(['collecting', 'collecting']);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('keeps polling when recording the state fails, and tries the write again next time', async () => {
      const { collector, record, getClusterSnapshot } = setup([], {
        stopAfterInserts: 2,
        record: async () => { throw new Error('db down'); },
      });

      await collector.run();

      expect(getClusterSnapshot).toHaveBeenCalledTimes(2);
      expect(record).toHaveBeenCalledTimes(2);
    });

    it('does not blame Proxmox when storing the rows fails', async () => {
      const { collector, writes, insert, controller } = setup([]);
      insert.mockImplementationOnce(async () => { throw new Error('insert failed'); });
      insert.mockImplementationOnce(async () => { controller.abort(); });

      await collector.run();

      expect(writes.map((w) => w.state)).toEqual(['collecting']);
    });
  });
});

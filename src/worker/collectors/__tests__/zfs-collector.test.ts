import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { ZfsPool, ZfsStatsFrame } from '@homelab-manager/agent/types/protocol';
import { AgentZfsFrameError, ZFSCollector } from '../zfs-collector';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';
import type { NewZFSStat } from '@/lib/database/repositories/stats-repository';
import { fixedStream, type StreamConnector } from '@/lib/test/agent-sse-stream-fixtures';
import { mockSetTimeout, type TimerMock } from '@/lib/test/mock-timers';

const IO = { readOps: 10, writeOps: 20, readBytes: 102400, writeBytes: 204800 };

/** A frame as the agent builds it, so a drift between the agent's builder and this test fails typecheck. */
function frame(pools: ZfsPool[], time = 1700000000000): ZfsStatsFrame {
  return { v: 1, time, pools };
}

const TANK: ZfsPool = {
  name: 'tank',
  capacity: { allocBytes: '1990116046274', freeBytes: '2407908633477' },
  io: IO,
  children: [
    {
      kind: 'vdev',
      name: 'mirror-0',
      capacity: { allocBytes: '1990116046274', freeBytes: '2407908633477' },
      io: IO,
      children: [
        { kind: 'disk', name: 'sda', capacity: null, io: IO },
        { kind: 'disk', name: 'sdb', capacity: null, io: IO },
      ],
    },
    { kind: 'group', group: 'logs', children: [{ kind: 'disk', name: 'nvme0n1', capacity: { allocBytes: '0', freeBytes: '17179869184' }, io: IO }] },
    { kind: 'group', group: 'spares', children: [{ kind: 'disk', name: 'sdz', capacity: null, io: null }] },
  ],
};

/** Create a mock DatabaseClient that captures insertZFSStats calls */
function createMockDb() {
  const insertedRows: NewZFSStat[][] = [];
  return {
    db: {
      getPool: () => ({
        query: async () => ({ rows: [], rowCount: 0 }),
      }),
    } as any,
    insertedRows,
    /** Patch the repository after construction */
    patchRepository(collector: ZFSCollector) {
      const repo = (collector as any).repository;
      repo.insertZFSStats = async (rows: NewZFSStat[]) => {
        insertedRows.push(rows);
      };
    },
  };
}

/** Resolves when a row batch is written to `insertedRows` (first cycle flushed to the DB). */
function watchFirstInsert(insertedRows: NewZFSStat[][]): Promise<void> {
  let mark = () => {};
  const written = new Promise<void>(resolve => { mark = resolve; });
  const originalPush = insertedRows.push.bind(insertedRows);
  insertedRows.push = ((...rows: NewZFSStat[][]) => {
    const result = originalPush(...rows);
    mark();
    return result;
  }) as typeof insertedRows.push;
  return written;
}

const defaultConfig = {
  docker: { enabled: false },
  zfs: { enabled: true },
  proxmox: { enabled: false },
  collection: { interval: 1000 },
} as any;

const sampleHost: ManagedHost = {
  id: 1,
  name: 'test-zfs',
  agentUrl: 'http://192.168.1.50:9090',
  capabilities: { docker: true, zfs: true },
  agentVersion: '0.1.0',
  agentImage: null,
  agentImageTag: null,
  agentImageDigest: null,
  agentOutOfDate: false,
  failure: null,
  status: 'healthy',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  lastSweptAt: null,
};

describe('ZFSCollector', () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let abortController: AbortController;

  beforeEach(() => {
    mockDb = createMockDb();
    abortController = new AbortController();
  });

  describe('construction', () => {
    it('should set name from host config', () => {
      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController,
      );
      expect(collector.name).toBe('ZFSCollector[test-zfs]');
    });

    it('should set custom name from host config', () => {
      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, { ...sampleHost, name: 'nas-server' }, async () => 'test-token', abortController,
      );
      expect(collector.name).toBe('ZFSCollector[nas-server]');
    });

    it('should implement AsyncDisposable', async () => {
      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController,
      );
      expect(Symbol.asyncDispose in collector).toBe(true);
      await collector[Symbol.asyncDispose]();
    });

    it('should be stoppable', () => {
      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, async () => 'test-token',
      );
      collector.stop();
      expect((collector as any).signal.aborted).toBe(true);
    });
  });

  describe('collect()', () => {
    async function collectFrames(frames: unknown[], host: ManagedHost = sampleHost): Promise<NewZFSStat[][]> {
      const db = createMockDb();
      const collector = new ZFSCollector(db.db, defaultConfig, host, async () => 'test-token', abortController, fixedStream(frames));
      db.patchRepository(collector);
      await (collector as any).collect();
      return db.insertedRows;
    }

    it('writes one row per node with pool-relative entities, node types and the agent sample time', async () => {
      const [rows, ...rest] = await collectFrames([frame([TANK])]);

      expect(rest).toEqual([]);
      expect(rows.map((r) => [r.entity, r.entityType, r.indent])).toEqual([
        ['tank', 'pool', 0],
        ['tank/mirror-0', 'vdev', 2],
        ['tank/mirror-0/sda', 'disk', 4],
        ['tank/mirror-0/sdb', 'disk', 4],
        ['tank/@logs', 'group', 2],
        ['tank/@logs/nvme0n1', 'disk', 4],
        ['tank/@spares', 'group', 2],
        ['tank/@spares/sdz', 'disk', 4],
      ]);
      for (const row of rows) {
        expect(row.host).toBe('test-zfs');
        expect(row.pool).toBe('tank');
        expect(row.time).toEqual(new Date(1700000000000));
      }
      expect(rows[0]).toMatchObject({ capacityAllocBytes: '1990116046274', capacityFreeBytes: '2407908633477', readOpsPerSec: 10, writeBytesPerSec: 204800 });
    });

    it('stores no capacity and no I/O for groups and spares', async () => {
      const [rows] = await collectFrames([frame([TANK])]);
      const blank = { capacityAllocBytes: null, capacityFreeBytes: null, readOpsPerSec: null, writeOpsPerSec: null, readBytesPerSec: null, writeBytesPerSec: null };

      expect(rows.find((r) => r.entity === 'tank/@spares')).toMatchObject(blank);
      expect(rows.find((r) => r.entity === 'tank/@spares/sdz')).toMatchObject(blank);
    });

    it('writes the same entities whatever address the agent is reached at', async () => {
      const entities = async (agentUrl: string) => (await collectFrames([frame([TANK])], { ...sampleHost, agentUrl }))[0].map((r) => `${r.host}|${r.entity}`);

      const plain = await entities('http://192.168.1.50:9090');
      expect(await entities('http://10.0.0.7:9090')).toEqual(plain);
      expect(await entities('https://nas.lan:9443')).toEqual(plain);
      expect(plain[0]).toBe('test-zfs|tank');
    });

    it('keeps byte counts past 2^53 exact', async () => {
      const huge: ZfsPool = { ...TANK, capacity: { allocBytes: '9007199254740993', freeBytes: '18446744073709551615' }, children: [] };
      const [[row]] = await collectFrames([frame([huge])]);

      expect(row.capacityAllocBytes).toBe('9007199254740993');
      expect(row.capacityFreeBytes).toBe('18446744073709551615');
    });

    it('escapes names that would split the entity path', async () => {
      const files: ZfsPool = { ...TANK, children: [{ kind: 'disk', name: '/var/lib/zfs/a.img', capacity: null, io: IO }] };
      const [rows] = await collectFrames([frame([files])]);

      expect(rows[1].entity).toBe('tank/%2Fvar%2Flib%2Fzfs%2Fa.img');
    });

    it('writes each sample with every pool, and nothing for a sample with none', async () => {
      const backup: ZfsPool = { ...TANK, name: 'backup', children: [] };
      const inserted = await collectFrames([frame([TANK, backup], 1), frame([], 2), frame([backup], 3)]);

      expect(inserted.map((rows) => [...new Set(rows.map((r) => r.pool))])).toEqual([['tank', 'backup'], ['backup']]);
    });

    it('marks the host and takes the error path when the agent sends the old text-line frames', async () => {
      const db = createMockDb();
      const collector = new ZFSCollector(
        db.db, defaultConfig, sampleHost, async () => 'test-token', abortController,
        fixedStream([{ line: 'tank  1.81T  2.19T  10  20  100K  200K', timestamp: 1 }, frame([TANK])]),
      );
      db.patchRepository(collector);

      await expect((collector as any).collect()).rejects.toBeInstanceOf(AgentZfsFrameError);

      expect(db.insertedRows).toHaveLength(1);
      expect(db.insertedRows[0]).toEqual([expect.objectContaining({ host: 'test-zfs', pool: '', entity: '', entityType: 'agent_outdated', capacityAllocBytes: null })]);
    });

    it.each([
      ['a non-object', 42],
      ['an agent error event', { error: 'connection lost' }],
      ['a frame from another protocol version', { v: 2, time: 1, pools: [] }],
      ['a frame with a rounded byte count', frame([{ ...TANK, capacity: { allocBytes: '1.81T', freeBytes: '0' } }])],
    ])('takes the error path without marking the host on %s', async (_label, bad) => {
      const db = createMockDb();
      const collector = new ZFSCollector(db.db, defaultConfig, sampleHost, async () => 'test-token', abortController, fixedStream([bad]));
      db.patchRepository(collector);

      await expect((collector as any).collect()).rejects.toBeInstanceOf(AgentZfsFrameError);
      expect(db.insertedRows).toEqual([]);
    });

    it('should connect with the configured agent URL, path, and signer', async () => {
      const connectSpy = mock(fixedStream([]));

      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController, connectSpy as unknown as StreamConnector,
      );
      mockDb.patchRepository(collector);

      await (collector as any).collect();

      expect(connectSpy).toHaveBeenCalledTimes(1);
      const callArgs = connectSpy.mock.calls[0][0] as { agentUrl: string; path: string; signal: AbortSignal };
      expect(callArgs.agentUrl).toBe('http://192.168.1.50:9090');
      expect(callArgs.path).toBe('/zfs/stats/stream');
      expect(callArgs.signal).toBe(abortController.signal);
    });

    it('should propagate a connection failure from the stream connector', async () => {
      const streamConnector: StreamConnector = async () => {
        throw new Error('Agent returned 401: Unauthorized');
      };

      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController, streamConnector,
      );
      mockDb.patchRepository(collector);

      await expect((collector as any).collect()).rejects.toThrow('Agent returned 401');
    });

    it('should stop processing when abort signal fires', async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const streamConnector: StreamConnector = async function* () {
        yield frame([TANK], 1);
        await gate;
        yield frame([TANK], 2);
      } as unknown as StreamConnector;

      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController, streamConnector,
      );
      mockDb.patchRepository(collector);
      const firstWritten = watchFirstInsert(mockDb.insertedRows);

      const collectPromise = (collector as any).collect();
      await firstWritten;
      abortController.abort(new DOMException('Shutdown', 'AbortError'));
      release();
      await collectPromise;

      expect(mockDb.insertedRows).toHaveLength(1);
    });
  });

  describe('reconnection', () => {
    let timers: TimerMock;

    beforeEach(() => {
      timers = mockSetTimeout({ fireImmediately: true });
      spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      timers.restore();
      mock.restore();
    });

    it('backs off further on each reconnect to an agent too old to read, instead of reconnecting every second', async () => {
      let callCount = 0;
      const streamConnector: StreamConnector = async () => {
        callCount++;
        if (callCount === 3) abortController.abort(new DOMException('Shutdown', 'AbortError'));
        return (async function* () {
          yield { line: 'tank  1.81T  2.19T  10  20  100K  200K', timestamp: 1 };
        })();
      };

      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController, streamConnector,
      );
      mockDb.patchRepository(collector);

      await collector.run();

      expect(timers.delays).toEqual([1000, 2000]);
      expect(mockDb.insertedRows.flat().map((r) => r.entityType)).toEqual(['agent_outdated', 'agent_outdated']);
    });

    it('resets the backoff once a readable frame arrives', async () => {
      let callCount = 0;
      const streamConnector: StreamConnector = async () => {
        callCount++;
        if (callCount === 3) {
          abortController.abort(new DOMException('Shutdown', 'AbortError'));
          return (async function* () {})();
        }
        return (async function* () {
          yield frame([TANK]);
          throw new Error('Connection reset');
        })();
      };

      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController, streamConnector,
      );
      mockDb.patchRepository(collector);

      await collector.run();

      expect(timers.delays).toEqual([1000, 1000]);
    });

    it('run() reconnects after a connect failure with backoff', async () => {
      let callCount = 0;

      const streamConnector: StreamConnector = async () => {
        callCount++;
        if (callCount <= 2) {
          throw new Error('Agent returned 503: Service Unavailable');
        }
        abortController.abort(new DOMException('Shutdown', 'AbortError'));
        return (async function* () {})();
      };

      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController, streamConnector,
      );
      mockDb.patchRepository(collector);

      await collector.run();

      expect(callCount).toBeGreaterThanOrEqual(3);
      expect(timers.delays).toEqual([1000, 2000]);
    });
  });

  describe('debug logging', () => {
    it('should support debug logging toggle', () => {
      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController,
      );
      collector.dockerDebugLogging = true;
      collector.dockerDebugLogging = false;
    });

    it('should support db flush debug logging toggle', () => {
      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController,
      );
      collector.dbFlushDebugLogging = true;
      collector.dbFlushDebugLogging = false;
    });
  });
});

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { ZFSCollector } from '../zfs-collector';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';
import type { NewZFSStat } from '@/lib/database/repositories/stats-repository';
import { fixedStream, type StreamConnector } from '@/lib/test/agent-sse-stream-fixtures';

/** Wrap a list of ZFS iostat lines as `{ line }` frames (optionally with an agent timestamp). */
function lineFrames(lines: string[], timestamp?: number): unknown[] {
  return lines.map((line) => (timestamp === undefined ? { line } : { line, timestamp }));
}

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
  status: 'healthy',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

// Simulate zpool iostat -vvv output lines sent as SSE events
const IOSTAT_LINES = [
  '              capacity     operations     bandwidth',
  'pool        alloc   free   read  write   read  write',
  '----------  -----  -----  -----  -----  -----  -----',
  'tank        1.81T  2.19T     10     20   100K   200K',
  '  mirror-0      -      -      5     10    50K   100K',
  '    sda         -      -      3      5    25K    50K',
  '    sdb         -      -      2      5    25K    50K',
  '              capacity     operations     bandwidth',
];

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
    it('should parse iostat output and write rows with correct hierarchy', async () => {
      const streamConnector = fixedStream(lineFrames(IOSTAT_LINES));

      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController, streamConnector,
      );
      mockDb.patchRepository(collector);

      await (collector as any).collect();

      // The second header line triggers a flush of the first cycle
      expect(mockDb.insertedRows.length).toBe(1);
      const rows = mockDb.insertedRows[0];

      // Should have 4 rows: pool + vdev + 2 disks
      expect(rows.length).toBe(4);

      // Pool row (entity prefixed with host identifier from agentUrl)
      expect(rows[0].entity).toBe('192.168.1.50:9090/tank');
      expect(rows[0].entityType).toBe('pool');
      expect(rows[0].pool).toBe('tank');
      expect(rows[0].host).toBe('test-zfs');
      expect(rows[0].indent).toBe(0);

      // Vdev row
      expect(rows[1].entity).toBe('192.168.1.50:9090/tank/mirror-0');
      expect(rows[1].entityType).toBe('vdev');
      expect(rows[1].pool).toBe('tank');
      expect(rows[1].indent).toBe(2);

      // Disk rows
      expect(rows[2].entity).toBe('192.168.1.50:9090/tank/mirror-0/sda');
      expect(rows[2].entityType).toBe('disk');
      expect(rows[2].pool).toBe('tank');
      expect(rows[2].indent).toBe(4);

      expect(rows[3].entity).toBe('192.168.1.50:9090/tank/mirror-0/sdb');
      expect(rows[3].entityType).toBe('disk');
    });

    it('should write final cycle when stream ends without trailing header', async () => {
      const lines = [
        '              capacity     operations     bandwidth',
        'pool        alloc   free   read  write   read  write',
        '----------  -----  -----  -----  -----  -----  -----',
        'rpool       100G   900G      1      2    10K    20K',
      ];

      const streamConnector = fixedStream(lineFrames(lines));

      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController, streamConnector,
      );
      mockDb.patchRepository(collector);

      await (collector as any).collect();

      // Final cycle should be written in the finally block
      expect(mockDb.insertedRows.length).toBe(1);
      expect(mockDb.insertedRows[0].length).toBe(1);
      expect(mockDb.insertedRows[0][0].entity).toBe('192.168.1.50:9090/rpool');
      expect(mockDb.insertedRows[0][0].entityType).toBe('pool');
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

    it('should skip empty lines', async () => {
      const lines = [
        '              capacity     operations     bandwidth',
        '',
        '   ',
        'tank        1.81T  2.19T     10     20   100K   200K',
        '              capacity     operations     bandwidth',
      ];

      const streamConnector = fixedStream(lineFrames(lines));

      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController, streamConnector,
      );
      mockDb.patchRepository(collector);

      await (collector as any).collect();

      expect(mockDb.insertedRows.length).toBe(1);
      expect(mockDb.insertedRows[0].length).toBe(1);
      expect(mockDb.insertedRows[0][0].entity).toBe('192.168.1.50:9090/tank');
    });

    it('should skip non-object frame values', async () => {
      const streamConnector = fixedStream([null, 42, 'just a string']);

      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController, streamConnector,
      );
      mockDb.patchRepository(collector);

      await (collector as any).collect();

      // No rows should be written
      expect(mockDb.insertedRows.length).toBe(0);
    });

    it('should skip agent error events', async () => {
      const streamConnector = fixedStream([{ error: 'connection lost' }]);

      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController, streamConnector,
      );
      mockDb.patchRepository(collector);

      await (collector as any).collect();

      expect(mockDb.insertedRows.length).toBe(0);
    });

    it('should use agent-provided timestamp for the written row time field', async () => {
      const FIXED_TIMESTAMP = 1700000000000;

      // A minimal single-cycle stream: header line triggers a new cycle, then the pool
      // data line is written when the stream closes (final-cycle flush).
      const lines = [
        '              capacity     operations     bandwidth',
        'tank        1.81T  2.19T     10     20   100K   200K',
      ];

      const streamConnector = fixedStream(lineFrames(lines, FIXED_TIMESTAMP));

      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController, streamConnector,
      );
      mockDb.patchRepository(collector);

      await (collector as any).collect();

      // Exactly one cycle should have been flushed via the final-cycle path
      expect(mockDb.insertedRows.length).toBe(1);
      const row = mockDb.insertedRows[0][0];

      // The row's time must reflect the agent timestamp, not Date.now()
      expect(row.time).toEqual(new Date(FIXED_TIMESTAMP));
      // Confirm the entity is correct so we know this is the right row
      expect(row.entity).toBe('192.168.1.50:9090/tank');
    });

    it('should stop processing when abort signal fires', async () => {
      const headerLine = { line: '              capacity     operations     bandwidth' };
      const dataLine = { line: 'tank        1.81T  2.19T     10     20   100K   200K' };

      // Gates are pre-created so releasing one is safe even before the generator awaits it.
      const gates = Array.from({ length: 10 }, () => {
        let release: () => void = () => {};
        const promise = new Promise<void>(resolve => { release = resolve; });
        return { promise, release };
      });

      const streamConnector: StreamConnector = async function* () {
        for (let i = 0; i < 10; i++) {
          yield headerLine;
          yield dataLine;
          await gates[i].promise;
        }
      } as unknown as StreamConnector;

      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController, streamConnector,
      );
      mockDb.patchRepository(collector);

      const firstCycleWritten = watchFirstInsert(mockDb.insertedRows);

      const collectPromise = (collector as any).collect();

      // Release the first cycle's header+data so the second header line triggers the flush.
      gates[0].release();
      await firstCycleWritten;

      // for-await loop checks signal.aborted before processing the next frame.
      abortController.abort(new DOMException('Shutdown', 'AbortError'));

      await collectPromise;

      // At least one cycle should have been written before abort
      expect(mockDb.insertedRows.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('reconnection', () => {
    it('run() reconnects after stream error with backoff', async () => {
      let callCount = 0;

      const streamConnector: StreamConnector = async () => {
        callCount++;
        if (callCount === 1) {
          // First cycle errors mid-stream.
          return (async function* () {
            yield { line: 'tank        1.81T  2.19T     10     20   100K   200K' };
            throw new Error('Connection reset');
          })();
        }
        // Second call: abort to end the test
        abortController.abort(new DOMException('Shutdown', 'AbortError'));
        return (async function* () {})();
      };

      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController, streamConnector,
      );
      mockDb.patchRepository(collector);

      await collector.run();

      expect(callCount).toBeGreaterThanOrEqual(2);
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

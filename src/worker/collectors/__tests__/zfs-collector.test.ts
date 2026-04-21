import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { ZFSCollector } from '../zfs-collector';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';
import type { ZFSStatsRow } from '@/types/zfs';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Create a mock DatabaseClient that captures insertZFSStats calls */
function createMockDb() {
  const insertedRows: ZFSStatsRow[][] = [];
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
      repo.insertZFSStats = async (rows: ZFSStatsRow[]) => {
        insertedRows.push(rows);
      };
    },
  };
}

const defaultConfig = {
  enabled: true,
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

/** Build a ReadableStream that emits SSE-formatted ZFS line events, then closes */
function createMockZfsSSEStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        const event = { line };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
}

/**
 * Build a ReadableStream that emits SSE-formatted ZFS line events with an explicit
 * agent-provided timestamp, then closes.
 */
function createMockZfsSSEStreamWithTimestamp(lines: string[], timestamp: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        const event = { line, timestamp };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
}

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
        mockDb.db, defaultConfig, sampleHost, 'test-token', abortController,
      );
      expect(collector.name).toBe('ZFSCollector[test-zfs]');
    });

    it('should set custom name from host config', () => {
      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, { ...sampleHost, name: 'nas-server' }, 'test-token', abortController,
      );
      expect(collector.name).toBe('ZFSCollector[nas-server]');
    });

    it('should implement AsyncDisposable', async () => {
      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, 'test-token', abortController,
      );
      expect(Symbol.asyncDispose in collector).toBe(true);
      await collector[Symbol.asyncDispose]();
    });

    it('should be stoppable', () => {
      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, 'test-token',
      );
      collector.stop();
      expect((collector as any).signal.aborted).toBe(true);
    });
  });

  describe('collect()', () => {
    it('should parse iostat output and write rows with correct hierarchy', async () => {
      const fetchFn: FetchFn = mock(async () =>
        new Response(createMockZfsSSEStream(IOSTAT_LINES), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );

      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, 'test-token', abortController, fetchFn,
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
      expect(rows[0].entity_type).toBe('pool');
      expect(rows[0].pool).toBe('tank');
      expect(rows[0].host).toBe('test-zfs');
      expect(rows[0].indent).toBe(0);

      // Vdev row
      expect(rows[1].entity).toBe('192.168.1.50:9090/tank/mirror-0');
      expect(rows[1].entity_type).toBe('vdev');
      expect(rows[1].pool).toBe('tank');
      expect(rows[1].indent).toBe(2);

      // Disk rows
      expect(rows[2].entity).toBe('192.168.1.50:9090/tank/mirror-0/sda');
      expect(rows[2].entity_type).toBe('disk');
      expect(rows[2].pool).toBe('tank');
      expect(rows[2].indent).toBe(4);

      expect(rows[3].entity).toBe('192.168.1.50:9090/tank/mirror-0/sdb');
      expect(rows[3].entity_type).toBe('disk');
    });

    it('should write final cycle when stream ends without trailing header', async () => {
      const lines = [
        '              capacity     operations     bandwidth',
        'pool        alloc   free   read  write   read  write',
        '----------  -----  -----  -----  -----  -----  -----',
        'rpool       100G   900G      1      2    10K    20K',
      ];

      const fetchFn: FetchFn = mock(async () =>
        new Response(createMockZfsSSEStream(lines), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );

      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, 'test-token', abortController, fetchFn,
      );
      mockDb.patchRepository(collector);

      await (collector as any).collect();

      // Final cycle should be written in the finally block
      expect(mockDb.insertedRows.length).toBe(1);
      expect(mockDb.insertedRows[0].length).toBe(1);
      expect(mockDb.insertedRows[0][0].entity).toBe('192.168.1.50:9090/rpool');
      expect(mockDb.insertedRows[0][0].entity_type).toBe('pool');
    });

    it('should send Authorization header with bearer token', async () => {
      const fetchFn: FetchFn = mock(async () =>
        new Response(createMockZfsSSEStream([]), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );

      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, 'test-token', abortController, fetchFn,
      );
      mockDb.patchRepository(collector);

      await (collector as any).collect();

      expect(fetchFn).toHaveBeenCalledTimes(1);
      const mockFn = fetchFn as unknown as { mock: { calls: unknown[][] } };
      const callArgs = mockFn.mock.calls[0] as [string, RequestInit];
      expect(callArgs[0]).toBe('http://192.168.1.50:9090/zfs/stats/stream');
      expect(callArgs[1].headers).toEqual({
        Authorization: 'Bearer test-token',
      });
    });

    it('should pass abort signal to fetch', async () => {
      const fetchFn: FetchFn = mock(async (_url: string, opts?: RequestInit) => {
        expect(opts?.signal).toBeDefined();
        return new Response(createMockZfsSSEStream([]), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      });

      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, 'test-token', abortController, fetchFn,
      );
      mockDb.patchRepository(collector);

      await (collector as any).collect();
    });

    it('should throw on non-200 response', async () => {
      const fetchFn: FetchFn = mock(async () =>
        new Response('Unauthorized', { status: 401 })
      );

      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, 'test-token', abortController, fetchFn,
      );
      mockDb.patchRepository(collector);

      await expect((collector as any).collect()).rejects.toThrow('Agent returned 401');
    });

    it('should throw when response has no body', async () => {
      const fetchFn: FetchFn = mock(async () => {
        const resp = new Response(null, { status: 200 });
        // Override body to null
        Object.defineProperty(resp, 'body', { value: null });
        return resp;
      });

      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, 'test-token', abortController, fetchFn,
      );
      mockDb.patchRepository(collector);

      await expect((collector as any).collect()).rejects.toThrow('Agent response has no body');
    });

    it('should skip empty lines', async () => {
      const lines = [
        '              capacity     operations     bandwidth',
        '',
        '   ',
        'tank        1.81T  2.19T     10     20   100K   200K',
        '              capacity     operations     bandwidth',
      ];

      const fetchFn: FetchFn = mock(async () =>
        new Response(createMockZfsSSEStream(lines), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );

      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, 'test-token', abortController, fetchFn,
      );
      mockDb.patchRepository(collector);

      await (collector as any).collect();

      expect(mockDb.insertedRows.length).toBe(1);
      expect(mockDb.insertedRows[0].length).toBe(1);
      expect(mockDb.insertedRows[0][0].entity).toBe('192.168.1.50:9090/tank');
    });

    it('should skip malformed JSON in SSE events', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: {not valid json}\n\n`));
          // Valid header to trigger cycle
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ line: '              capacity     operations     bandwidth' })}\n\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ line: 'tank        1.81T  2.19T     10     20   100K   200K' })}\n\n`));
          controller.close();
        },
      });

      const fetchFn: FetchFn = mock(async () =>
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );

      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, 'test-token', abortController, fetchFn,
      );
      mockDb.patchRepository(collector);

      await (collector as any).collect();

      // Final cycle written - only the tank row
      expect(mockDb.insertedRows.length).toBe(1);
      expect(mockDb.insertedRows[0][0].entity).toBe('192.168.1.50:9090/tank');
    });

    it('should skip non-object JSON values', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: null\n\n`));
          controller.enqueue(encoder.encode(`data: 42\n\n`));
          controller.enqueue(encoder.encode(`data: "just a string"\n\n`));
          controller.close();
        },
      });

      const fetchFn: FetchFn = mock(async () =>
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );

      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, 'test-token', abortController, fetchFn,
      );
      mockDb.patchRepository(collector);

      await (collector as any).collect();

      // No rows should be written
      expect(mockDb.insertedRows.length).toBe(0);
    });

    it('should skip agent error events', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`event: error\ndata: {"error":"connection lost"}\n\n`));
          controller.close();
        },
      });

      const fetchFn: FetchFn = mock(async () =>
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );

      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, 'test-token', abortController, fetchFn,
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

      const fetchFn: FetchFn = mock(async () =>
        new Response(createMockZfsSSEStreamWithTimestamp(lines, FIXED_TIMESTAMP), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );

      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, 'test-token', abortController, fetchFn,
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

    it('should handle partial SSE messages across chunks', async () => {
      const encoder = new TextEncoder();
      const event = { line: 'tank        1.81T  2.19T     10     20   100K   200K' };
      const headerEvent = { line: '              capacity     operations     bandwidth' };
      const fullMsg = `data: ${JSON.stringify(headerEvent)}\n\ndata: ${JSON.stringify(event)}\n\n`;
      const part1 = fullMsg.slice(0, 20);
      const part2 = fullMsg.slice(20);

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(part1));
          controller.enqueue(encoder.encode(part2));
          controller.close();
        },
      });

      const fetchFn: FetchFn = mock(async () =>
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );

      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, 'test-token', abortController, fetchFn,
      );
      mockDb.patchRepository(collector);

      await (collector as any).collect();

      // Final cycle written with the tank row
      expect(mockDb.insertedRows.length).toBe(1);
      expect(mockDb.insertedRows[0][0].entity).toBe('192.168.1.50:9090/tank');
    });

    it('should stop processing when abort signal fires', async () => {
      const encoder = new TextEncoder();
      let eventCount = 0;
      const headerLine = { line: '              capacity     operations     bandwidth' };
      const dataLine = { line: 'tank        1.81T  2.19T     10     20   100K   200K' };

      const neverEndingStream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          eventCount++;
          if (eventCount <= 10) {
            // Emit a header + data cycle
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(headerLine)}\n\n`));
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(dataLine)}\n\n`));
            await new Promise(resolve => setTimeout(resolve, 20));
          } else {
            controller.close();
          }
        },
      });

      const fetchFn: FetchFn = mock(async () =>
        new Response(neverEndingStream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );

      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, 'test-token', abortController, fetchFn,
      );
      mockDb.patchRepository(collector);

      // Abort after a short delay
      setTimeout(() => abortController.abort(new DOMException('Shutdown', 'AbortError')), 50);

      await (collector as any).collect();

      // At least one cycle should have been written before abort
      expect(mockDb.insertedRows.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('reconnection', () => {
    it('run() reconnects after stream error with backoff', async () => {
      let callCount = 0;
      const encoder = new TextEncoder();

      const fetchFn: FetchFn = mock(async () => {
        callCount++;
        if (callCount === 1) {
          // First call: error stream
          const errorStream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ line: 'tank        1.81T  2.19T     10     20   100K   200K' })}\n\n`));
              controller.error(new Error('Connection reset'));
            },
          });
          return new Response(errorStream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }
        // Second call: abort to end the test
        abortController.abort(new DOMException('Shutdown', 'AbortError'));
        return new Response(createMockZfsSSEStream([]), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      });

      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, 'test-token', abortController, fetchFn,
      );
      mockDb.patchRepository(collector);

      await collector.run();

      expect(callCount).toBeGreaterThanOrEqual(2);
    });

    it('run() reconnects after non-200 response with backoff', async () => {
      let callCount = 0;

      const fetchFn: FetchFn = mock(async () => {
        callCount++;
        if (callCount <= 2) {
          return new Response('Service Unavailable', { status: 503 });
        }
        abortController.abort(new DOMException('Shutdown', 'AbortError'));
        return new Response(createMockZfsSSEStream([]), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      });

      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, 'test-token', abortController, fetchFn,
      );
      mockDb.patchRepository(collector);

      await collector.run();

      expect(callCount).toBeGreaterThanOrEqual(3);
    });
  });

  describe('debug logging', () => {
    it('should support debug logging toggle', () => {
      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, 'test-token', abortController,
      );
      collector.dockerDebugLogging = true;
      collector.dockerDebugLogging = false;
    });

    it('should support db flush debug logging toggle', () => {
      const collector = new ZFSCollector(
        mockDb.db, defaultConfig, sampleHost, 'test-token', abortController,
      );
      collector.dbFlushDebugLogging = true;
      collector.dbFlushDebugLogging = false;
    });
  });
});

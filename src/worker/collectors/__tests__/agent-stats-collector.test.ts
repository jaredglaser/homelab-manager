import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { AgentStatsCollector } from '../agent-stats-collector';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';
import type { DockerStatsRow } from '@/types/docker';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Create a mock DatabaseClient that captures insertDockerStats calls */
function createMockDb() {
  const insertedRows: DockerStatsRow[][] = [];
  const upsertedMetadata: { source: string; entity: string; key: string; value: string }[] = [];
  return {
    db: {
      getPool: () => ({
        query: async () => ({ rows: [], rowCount: 0 }),
      }),
    } as any,
    insertedRows,
    upsertedMetadata,
    /** Patch the repository after construction */
    patchRepository(collector: AgentStatsCollector) {
      // Access the protected repository via any cast
      const repo = (collector as any).repository;
      repo.insertDockerStats = async (rows: DockerStatsRow[]) => {
        insertedRows.push(rows);
      };
      repo.upsertEntityMetadata = async (source: string, entity: string, key: string, value: string) => {
        upsertedMetadata.push({ source, entity, key, value });
      };
    },
  };
}

const defaultConfig = {
  enabled: true,
  docker: { enabled: true },
  zfs: { enabled: false },
  proxmox: { enabled: false },
  collection: { interval: 1000 },
} as any;

const sampleHost: ManagedHost = {
  id: 1,
  name: 'homeserver',
  agent_url: 'http://192.168.1.10:9090',
  agent_token_hash: '$2b$10$hashedtoken',
  agent_token: 'test-token-uuid',
  socket_proxy_url: 'tcp://192.168.1.10:2375',
  agent_version: '0.1.0',
  status: 'healthy',
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
};

/** Build a ReadableStream that emits SSE-formatted lines, then closes */
function createMockSSEStream(events: Record<string, unknown>[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
}

/** Build a ReadableStream that emits events then errors */
function createErrorSSEStream(events: Record<string, unknown>[], error: Error): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.error(error);
    },
  });
}

const sampleAgentEvent = {
  containerId: 'abc123def456',
  containerName: 'plex',
  image: 'plexinc/plex-media-server:latest',
  cpuPercent: 12.5,
  memoryUsage: 536870912,
  memoryLimit: 8589934592,
  memoryPercent: 6.25,
  networkRxBytesPerSec: 1024,
  networkTxBytesPerSec: 512,
  blockReadBytesPerSec: 2048,
  blockWriteBytesPerSec: 1024,
  timestamp: '2026-03-13T12:00:00.000Z',
};

describe('AgentStatsCollector', () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let abortController: AbortController;

  beforeEach(() => {
    mockDb = createMockDb();
    abortController = new AbortController();
  });

  it('has the correct name', () => {
    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, abortController,
    );
    expect(collector.name).toBe('AgentStatsCollector[homeserver]');
  });

  it('parses SSE events and inserts DockerStatsRow', async () => {
    const events = [sampleAgentEvent];
    const fetchFn: FetchFn = mock(async () =>
      new Response(createMockSSEStream(events), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, abortController, fetchFn,
    );
    mockDb.patchRepository(collector);

    // Run collection — the stream closes after one event, so collect() returns
    await (collector as any).collect();

    expect(mockDb.insertedRows).toHaveLength(1);
    const row = mockDb.insertedRows[0][0];
    expect(row.host).toBe('1');
    expect(row.container_id).toBe('abc123def456');
    expect(row.container_name).toBe('plex');
    expect(row.image).toBe('plexinc/plex-media-server:latest');
    expect(row.cpu_percent).toBe(12.5);
    expect(row.memory_usage).toBe(536870912);
    expect(row.memory_limit).toBe(8589934592);
    expect(row.memory_percent).toBe(6.25);
    expect(row.network_rx_bytes_per_sec).toBe(1024);
    expect(row.network_tx_bytes_per_sec).toBe(512);
    expect(row.block_io_read_bytes_per_sec).toBe(2048);
    expect(row.block_io_write_bytes_per_sec).toBe(1024);
  });

  it('sends Authorization header with bearer token', async () => {
    const fetchFn: FetchFn = mock(async () =>
      new Response(createMockSSEStream([]), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, abortController, fetchFn,
    );
    mockDb.patchRepository(collector);

    await (collector as any).collect();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const mockFn = fetchFn as unknown as { mock: { calls: unknown[][] } };
    const callArgs = mockFn.mock.calls[0] as [string, RequestInit];
    expect(callArgs[0]).toBe('http://192.168.1.10:9090/stats/stream');
    expect(callArgs[1].headers).toEqual({
      Authorization: 'Bearer test-token-uuid',
    });
  });

  it('passes abort signal to fetch', async () => {
    const fetchFn: FetchFn = mock(async (_url: string, opts?: RequestInit) => {
      // Verify signal is passed
      expect(opts?.signal).toBeDefined();
      return new Response(createMockSSEStream([]), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, abortController, fetchFn,
    );
    mockDb.patchRepository(collector);

    await (collector as any).collect();
  });

  it('upserts entity metadata for each container', async () => {
    const events = [sampleAgentEvent];
    const fetchFn: FetchFn = mock(async () =>
      new Response(createMockSSEStream(events), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, abortController, fetchFn,
    );
    mockDb.patchRepository(collector);

    await (collector as any).collect();

    // Should upsert name, image, and service_key for the container
    const nameUpsert = mockDb.upsertedMetadata.find(m => m.key === 'name');
    expect(nameUpsert).toBeDefined();
    expect(nameUpsert!.entity).toBe('1/abc123def456');
    expect(nameUpsert!.value).toBe('plex');

    const imageUpsert = mockDb.upsertedMetadata.find(m => m.key === 'image');
    expect(imageUpsert).toBeDefined();
    expect(imageUpsert!.value).toBe('plexinc/plex-media-server:latest');
  });

  it('throws on non-200 response', async () => {
    const fetchFn: FetchFn = mock(async () =>
      new Response('Unauthorized', { status: 401 })
    );

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, abortController, fetchFn,
    );
    mockDb.patchRepository(collector);

    await expect((collector as any).collect()).rejects.toThrow('Agent returned 401');
  });

  it('handles multiple events in sequence', async () => {
    const event2 = {
      ...sampleAgentEvent,
      containerId: 'def789ghi012',
      containerName: 'sonarr',
      image: 'linuxserver/sonarr:latest',
      cpuPercent: 3.2,
    };
    const fetchFn: FetchFn = mock(async () =>
      new Response(createMockSSEStream([sampleAgentEvent, event2]), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, abortController, fetchFn,
    );
    mockDb.patchRepository(collector);

    await (collector as any).collect();

    expect(mockDb.insertedRows).toHaveLength(2);
    expect(mockDb.insertedRows[0][0].container_name).toBe('plex');
    expect(mockDb.insertedRows[1][0].container_name).toBe('sonarr');
  });

  it('stops processing when abort signal fires', async () => {
    // Create a stream that emits events with a delay, allowing abort to fire between reads
    const encoder = new TextEncoder();
    let eventCount = 0;
    const neverEndingStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        eventCount++;
        if (eventCount <= 5) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(sampleAgentEvent)}\n\n`));
          // Small delay between events to allow abort to trigger
          await new Promise(resolve => setTimeout(resolve, 20));
        } else {
          // Safety: close after a few events if abort hasn't fired
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

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, abortController, fetchFn,
    );
    mockDb.patchRepository(collector);

    // Abort after a short delay
    setTimeout(() => abortController.abort(new DOMException('Shutdown', 'AbortError')), 50);

    // collect() should return once abort fires
    await (collector as any).collect();

    // At least one row should have been inserted before abort
    expect(mockDb.insertedRows.length).toBeGreaterThanOrEqual(1);
  });
});

describe('AgentStatsCollector — reconnection', () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let abortController: AbortController;

  beforeEach(() => {
    mockDb = createMockDb();
    abortController = new AbortController();
  });

  it('run() reconnects after stream error with backoff', async () => {
    let callCount = 0;
    const fetchFn: FetchFn = mock(async () => {
      callCount++;
      if (callCount === 1) {
        // First call: error stream
        return new Response(
          createErrorSSEStream([sampleAgentEvent], new Error('Connection reset')),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      // Second call: abort to end the test
      abortController.abort(new DOMException('Shutdown', 'AbortError'));
      return new Response(createMockSSEStream([]), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, abortController, fetchFn,
    );
    mockDb.patchRepository(collector);

    // run() drives the reconnection loop via BaseCollector
    await collector.run();

    // Should have been called at least twice (initial + reconnect)
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('run() reconnects after non-200 response with backoff', async () => {
    let callCount = 0;
    const fetchFn: FetchFn = mock(async () => {
      callCount++;
      if (callCount <= 2) {
        return new Response('Service Unavailable', { status: 503 });
      }
      // Third call: abort
      abortController.abort(new DOMException('Shutdown', 'AbortError'));
      return new Response(createMockSSEStream([]), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, abortController, fetchFn,
    );
    mockDb.patchRepository(collector);

    await collector.run();

    // BaseCollector handles the exponential backoff and retries
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it('handles partial SSE messages across chunks', async () => {
    // Simulate a message split across two chunks
    const encoder = new TextEncoder();
    const part1 = `data: {"containerId":"abc123","containerNa`;
    const part2 = `me":"plex","image":"plexinc/plex","cpuPercent":5,"memoryUsage":100,"memoryLimit":1000,"memoryPercent":10,"networkRxBytesPerSec":0,"networkTxBytesPerSec":0,"blockReadBytesPerSec":0,"blockWriteBytesPerSec":0,"timestamp":"2026-03-13T12:00:00Z"}\n\n`;

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

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, abortController, fetchFn,
    );
    mockDb.patchRepository(collector);

    await (collector as any).collect();

    expect(mockDb.insertedRows).toHaveLength(1);
    expect(mockDb.insertedRows[0][0].container_name).toBe('plex');
  });

  it('skips malformed JSON in SSE events', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Malformed event
        controller.enqueue(encoder.encode(`data: {not valid json}\n\n`));
        // Valid event
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(sampleAgentEvent)}\n\n`));
        controller.close();
      },
    });

    const fetchFn: FetchFn = mock(async () =>
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, abortController, fetchFn,
    );
    mockDb.patchRepository(collector);

    await (collector as any).collect();

    // Only the valid event should be inserted
    expect(mockDb.insertedRows).toHaveLength(1);
    expect(mockDb.insertedRows[0][0].container_name).toBe('plex');
  });

  it('skips non-object JSON values (null, primitives)', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: null\n\n`));
        controller.enqueue(encoder.encode(`data: 42\n\n`));
        controller.enqueue(encoder.encode(`data: "just a string"\n\n`));
        // Valid event
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(sampleAgentEvent)}\n\n`));
        controller.close();
      },
    });

    const fetchFn: FetchFn = mock(async () =>
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, abortController, fetchFn,
    );
    mockDb.patchRepository(collector);

    await (collector as any).collect();

    // Only the valid object event should be inserted
    expect(mockDb.insertedRows).toHaveLength(1);
    expect(mockDb.insertedRows[0][0].container_name).toBe('plex');
  });

  it('skips agent error events', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Agent error event
        controller.enqueue(encoder.encode(`event: error\ndata: {"error":"connection lost"}\n\n`));
        // Valid stats event
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(sampleAgentEvent)}\n\n`));
        controller.close();
      },
    });

    const fetchFn: FetchFn = mock(async () =>
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, abortController, fetchFn,
    );
    mockDb.patchRepository(collector);

    await (collector as any).collect();

    expect(mockDb.insertedRows).toHaveLength(1);
  });
});

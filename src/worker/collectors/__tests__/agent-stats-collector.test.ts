import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { AgentStatsCollector } from '../agent-stats-collector';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';
import type { NewDockerStat } from '@/lib/database/repositories/stats-repository';
import { fixedStream, type StreamConnector } from '@/lib/test/agent-sse-stream-fixtures';

/** Create a mock DatabaseClient that captures insertDockerStats calls */
function createMockDb() {
  const insertedRows: NewDockerStat[][] = [];
  const upsertedMetadata: { entity: string; key: string; value: string }[] = [];
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
      const repo = (collector as any).repository;
      const metaRepo = (collector as any).entityMetadataRepository;
      repo.insertDockerStats = async (rows: NewDockerStat[]) => {
        insertedRows.push(rows);
      };
      metaRepo.upsertEntityMetadataBatch = async (entries: { entity: string; key: string; value: string }[]) => {
        upsertedMetadata.push(...entries);
      };
    },
  };
}

/** Resolves when the collector's pendingRows buffer receives its first row. */
function watchFirstPush(collector: AgentStatsCollector): Promise<void> {
  let mark = () => {};
  const queued = new Promise<void>(resolve => { mark = resolve; });
  const pendingRows = (collector as any).pendingRows as NewDockerStat[];
  const originalPush = pendingRows.push.bind(pendingRows);
  pendingRows.push = ((...rows: NewDockerStat[]) => {
    const result = originalPush(...rows);
    mark();
    return result;
  }) as typeof pendingRows.push;
  return queued;
}

const defaultConfig = {
  docker: { enabled: true },
  zfs: { enabled: false },
  proxmox: { enabled: false },
  collection: { interval: 1000 },
} as any;

const sampleHost: ManagedHost = {
  id: 1,
  name: 'homeserver',
  agentUrl: 'http://192.168.1.10:9090',
  capabilities: { docker: true },
  agentVersion: '0.1.0',
  status: 'healthy',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

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
      mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController,
    );
    expect(collector.name).toBe('AgentStatsCollector[homeserver]');
  });

  it('shapes SSE events into a domain-shaped NewDockerStat', async () => {
    const streamConnector = fixedStream([sampleAgentEvent]);

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController, streamConnector,
    );
    mockDb.patchRepository(collector);

    // Run collection: the fixture stream ends after one event, so collect() returns
    await (collector as any).collect();

    expect(mockDb.insertedRows).toHaveLength(1);
    const row = mockDb.insertedRows[0][0];
    expect(row.host).toBe('homeserver');
    expect(row.containerId).toBe('abc123def456');
    expect(row.containerName).toBe('plex');
    expect(row.image).toBe('plexinc/plex-media-server:latest');
    expect(row.cpuPercent).toBe(12.5);
    expect(row.memoryUsage).toBe(536870912);
    expect(row.memoryLimit).toBe(8589934592);
    expect(row.memoryPercent).toBe(6.25);
    expect(row.networkRxBytesPerSec).toBe(1024);
    expect(row.networkTxBytesPerSec).toBe(512);
    expect(row.blockReadBytesPerSec).toBe(2048);
    expect(row.blockWriteBytesPerSec).toBe(1024);
    expect(row.time).toEqual(new Date('2026-03-13T12:00:00.000Z'));
  });

  it('connects with the configured agent URL, path, and signer', async () => {
    const connectSpy = mock(fixedStream([]));

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController, connectSpy as unknown as StreamConnector,
    );
    mockDb.patchRepository(collector);

    await (collector as any).collect();

    expect(connectSpy).toHaveBeenCalledTimes(1);
    const callArgs = connectSpy.mock.calls[0][0] as { agentUrl: string; path: string; signal: AbortSignal };
    expect(callArgs.agentUrl).toBe('http://192.168.1.10:9090');
    expect(callArgs.path).toBe('/stats/stream');
    expect(callArgs.signal).toBe(abortController.signal);
  });

  it('upserts entity metadata for each container', async () => {
    const streamConnector = fixedStream([sampleAgentEvent]);

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController, streamConnector,
    );
    mockDb.patchRepository(collector);

    await (collector as any).collect();

    // Should upsert name, image, and service_key for the container
    const nameUpsert = mockDb.upsertedMetadata.find(m => m.key === 'name');
    expect(nameUpsert).toBeDefined();
    expect(nameUpsert!.entity).toBe('homeserver/abc123def456');
    expect(nameUpsert!.value).toBe('plex');

    const imageUpsert = mockDb.upsertedMetadata.find(m => m.key === 'image');
    expect(imageUpsert).toBeDefined();
    expect(imageUpsert!.value).toBe('plexinc/plex-media-server:latest');
  });

  it('propagates a connection failure from the stream connector', async () => {
    const streamConnector: StreamConnector = async () => {
      throw new Error('Agent returned 401: Unauthorized');
    };

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController, streamConnector,
    );
    mockDb.patchRepository(collector);

    await expect((collector as any).collect()).rejects.toThrow('Agent returned 401');
  });

  it('skips non-object frames and agent error-only events', async () => {
    const streamConnector = fixedStream([
      null,
      42,
      { error: 'connection lost' },
      sampleAgentEvent,
    ]);

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController, streamConnector,
    );
    mockDb.patchRepository(collector);

    await (collector as any).collect();

    expect(mockDb.insertedRows).toHaveLength(1);
    expect(mockDb.insertedRows[0]).toHaveLength(1);
    expect(mockDb.insertedRows[0][0].containerName).toBe('plex');
  });

  it('survives a failed batch insert without throwing', async () => {
    let insertCallCount = 0;
    const events = [sampleAgentEvent, { ...sampleAgentEvent, containerId: 'def456', containerName: 'sonarr' }];
    const streamConnector = fixedStream(events);

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController, streamConnector,
    );
    const repo = (collector as any).repository;
    const metaRepo = (collector as any).entityMetadataRepository;
    metaRepo.upsertEntityMetadataBatch = async () => {};
    repo.insertDockerStats = async () => {
      insertCallCount++;
      throw new Error('DB write failed');
    };

    const origError = console.error;
    const errorMessages: string[] = [];
    console.error = (...args: unknown[]) => { errorMessages.push(String(args[0])); };
    try {
      await (collector as any).collect();
    } finally {
      console.error = origError;
    }

    // Both events flushed as one batch; flush failure was logged, not thrown
    expect(insertCallCount).toBe(1);
    expect(errorMessages.some(m => m.includes('Failed to insert batch of 2 stats rows'))).toBe(true);
  });

  it('retries entity metadata upsert on failure', async () => {
    let upsertCallCount = 0;
    const insertedCount = { value: 0 };
    const events = [sampleAgentEvent, sampleAgentEvent];
    const streamConnector = fixedStream(events);

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController, streamConnector,
    );
    const repo = (collector as any).repository;
    const metaRepo = (collector as any).entityMetadataRepository;
    // First upsert call throws (first event), second succeeds (retry on second event)
    metaRepo.upsertEntityMetadataBatch = async () => {
      upsertCallCount++;
      if (upsertCallCount === 1) throw new Error('DB connection lost');
    };
    repo.insertDockerStats = async (rows: NewDockerStat[]) => { insertedCount.value += rows.length; };

    const origError = console.error;
    console.error = () => {};
    try {
      await (collector as any).collect();
    } finally {
      console.error = origError;
    }

    // Both events should still produce stats (error doesn't prevent stat insertion)
    expect(insertedCount.value).toBe(2);
    // Container was NOT added to knownContainers on first failure, so second event retries upsert
    expect(upsertCallCount).toBe(2);
  });

  it('batches events arriving before a flush into one insert', async () => {
    const event2 = {
      ...sampleAgentEvent,
      containerId: 'def789ghi012',
      containerName: 'sonarr',
      image: 'linuxserver/sonarr:latest',
      cpuPercent: 3.2,
    };
    const streamConnector = fixedStream([sampleAgentEvent, event2]);

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController, streamConnector,
    );
    mockDb.patchRepository(collector);

    await (collector as any).collect();

    // Both events arrived within one flush window: one multi-row insert
    expect(mockDb.insertedRows).toHaveLength(1);
    expect(mockDb.insertedRows[0]).toHaveLength(2);
    expect(mockDb.insertedRows[0][0].containerName).toBe('plex');
    expect(mockDb.insertedRows[0][1].containerName).toBe('sonarr');
  });

  it('flushes accumulated rows on the interval while the stream stays open', async () => {
    let releaseSecondEvent: () => void = () => {};
    const secondEventGate = new Promise<void>(resolve => { releaseSecondEvent = resolve; });

    const streamConnector: StreamConnector = async function* () {
      yield sampleAgentEvent;
      // Hold the stream open past the 150 ms flush interval
      await secondEventGate;
      yield { ...sampleAgentEvent, containerId: 'def456', containerName: 'sonarr' };
    } as unknown as StreamConnector;

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController, streamConnector,
    );
    mockDb.patchRepository(collector);

    // Wait for the first row instead of sleeping past the real 150ms FLUSH_INTERVAL_MS.
    const firstRowQueued = watchFirstPush(collector);

    const collectPromise = (collector as any).collect();

    await firstRowQueued;
    await (collector as any).flushPendingRows();

    releaseSecondEvent();
    await collectPromise;

    // First event flushed by the manually-driven interval flush, second by the final drain
    expect(mockDb.insertedRows).toHaveLength(2);
    expect(mockDb.insertedRows[0][0].containerName).toBe('plex');
    expect(mockDb.insertedRows[1][0].containerName).toBe('sonarr');
  });

  it('stops processing when abort signal fires', async () => {
    // Gates are pre-created so releasing one is safe even before the generator awaits it.
    const gates = Array.from({ length: 5 }, () => {
      let release: () => void = () => {};
      const promise = new Promise<void>(resolve => { release = resolve; });
      return { promise, release };
    });
    const streamConnector: StreamConnector = async function* () {
      for (let i = 0; i < 5; i++) {
        yield sampleAgentEvent;
        await gates[i].promise;
      }
    } as unknown as StreamConnector;

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController, streamConnector,
    );
    mockDb.patchRepository(collector);

    const firstRowQueued = watchFirstPush(collector);

    const collectPromise = (collector as any).collect();
    await firstRowQueued;

    // for-await loop checks signal.aborted before processing the next frame.
    abortController.abort(new DOMException('Shutdown', 'AbortError'));
    gates[0].release();

    // collect() should return once abort fires
    await collectPromise;

    // At least one row should have been inserted before abort
    expect(mockDb.insertedRows.length).toBeGreaterThanOrEqual(1);
  });
});

describe('AgentStatsCollector: reconnection', () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let abortController: AbortController;

  beforeEach(() => {
    mockDb = createMockDb();
    abortController = new AbortController();
  });

  it('run() reconnects after stream error with backoff', async () => {
    let callCount = 0;
    const streamConnector: StreamConnector = async () => {
      callCount++;
      if (callCount === 1) {
        // First cycle: the stream errors immediately after one event.
        return (async function* () {
          yield sampleAgentEvent;
          throw new Error('Connection reset');
        })();
      }
      // Second call: abort to end the test
      abortController.abort(new DOMException('Shutdown', 'AbortError'));
      return (async function* () {})();
    };

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController, streamConnector,
    );
    mockDb.patchRepository(collector);

    // run() drives the reconnection loop via BaseCollector
    await collector.run();

    // Should have been called at least twice (initial + reconnect)
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('run() reconnects after a connect failure with backoff', async () => {
    let callCount = 0;
    const streamConnector: StreamConnector = async () => {
      callCount++;
      if (callCount <= 2) {
        throw new Error('Agent returned 503: Service Unavailable');
      }
      // Third call: abort
      abortController.abort(new DOMException('Shutdown', 'AbortError'));
      return (async function* () {})();
    };

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, async () => 'test-token', abortController, streamConnector,
    );
    mockDb.patchRepository(collector);

    await collector.run();

    // BaseCollector handles the exponential backoff and retries
    expect(callCount).toBeGreaterThanOrEqual(3);
  });
});

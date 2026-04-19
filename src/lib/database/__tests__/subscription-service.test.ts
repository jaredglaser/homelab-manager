import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { databaseConnectionManager } from '@/lib/clients/database-client';
import { StatsRepository } from '@/lib/database/repositories/stats-repository';
import { statsPollService } from '../subscription-service';

interface IntervalHandle {
  cb: () => Promise<void> | void;
  ms: number;
  cleared: boolean;
}

/**
 * Replace setInterval/clearInterval so each registered interval becomes a
 * callback we can invoke deterministically from tests (no real timers run).
 */
function createIntervalHarness() {
  const intervals: IntervalHandle[] = [];
  const setSpy = spyOn(globalThis, 'setInterval').mockImplementation(((cb: () => void, ms: number) => {
    const handle: IntervalHandle = { cb, ms, cleared: false };
    intervals.push(handle);
    return handle as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval);
  const clearSpy = spyOn(globalThis, 'clearInterval').mockImplementation(((h: unknown) => {
    const handle = h as IntervalHandle;
    if (handle) handle.cleared = true;
  }) as typeof clearInterval);
  return {
    intervals,
    restore() {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    },
  };
}

/** Minimal pg.Pool stand-in that records which pool instance received queries. */
function createMockPool(label: string) {
  const queries: { sql: string; params: unknown[] }[] = [];
  return {
    label,
    queries,
    pool: {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        return { rows: [] };
      },
    } as unknown as import('pg').Pool,
  };
}

/** Build a fake DatabaseClient whose getPool() returns the provided pool. */
function createMockDbClient(pool: import('pg').Pool) {
  return {
    id: 'mock-db',
    isConnected: () => true,
    getPool: () => pool,
  } as unknown as import('@/lib/clients/database-client').DatabaseClient;
}

describe('StatsPollService', () => {
  let harness: ReturnType<typeof createIntervalHarness>;
  let getClientSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    harness = createIntervalHarness();
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    // Ensure polling state is fully reset between tests — the service is a
    // module-level singleton, so lingering subscribers would leak across cases.
    await statsPollService.stop();
    getClientSpy?.mockRestore();
    errorSpy.mockRestore();
    harness.restore();
  });

  it('rebuilds the repo per tick and queries the current pool after reconnect', async () => {
    const firstPool = createMockPool('pool-1');
    const secondPool = createMockPool('pool-2');

    getClientSpy = spyOn(databaseConnectionManager, 'getClient')
      .mockResolvedValueOnce(createMockDbClient(firstPool.pool) as never)
      .mockResolvedValueOnce(createMockDbClient(secondPool.pool) as never);

    // Observe which pool StatsRepository is constructed with on each tick.
    const reposBuiltOn: import('pg').Pool[] = [];
    const ctorSpy = spyOn(StatsRepository.prototype, 'getDockerStatsSince').mockImplementation(
      async function getDockerStatsSince(this: StatsRepository) {
        // `this.pool` is private, but reading it through an index keeps the
        // assertion honest about which pool the per-tick repo holds.
        reposBuiltOn.push((this as unknown as { pool: import('pg').Pool }).pool);
        return [];
      },
    );

    const received: unknown[][] = [];
    statsPollService.subscribe('docker', rows => received.push(rows));

    expect(harness.intervals).toHaveLength(1);
    const tick = harness.intervals[0].cb;

    await tick();
    await tick();

    expect(getClientSpy).toHaveBeenCalledTimes(2);
    expect(reposBuiltOn).toHaveLength(2);
    expect(reposBuiltOn[0]).toBe(firstPool.pool);
    expect(reposBuiltOn[1]).toBe(secondPool.pool);

    ctorSpy.mockRestore();
  });

  it('does not throw on the healthy path when getClient returns the same client twice', async () => {
    const pool = createMockPool('pool-healthy');
    const client = createMockDbClient(pool.pool);

    getClientSpy = spyOn(databaseConnectionManager, 'getClient').mockResolvedValue(client as never);

    const querySpy = spyOn(StatsRepository.prototype, 'getDockerStatsSince').mockResolvedValue([]);

    statsPollService.subscribe('docker', () => {});
    const tick = harness.intervals[0].cb;

    await expect(tick()).resolves.toBeUndefined();
    await expect(tick()).resolves.toBeUndefined();

    expect(querySpy).toHaveBeenCalledTimes(2);
    expect(errorSpy).not.toHaveBeenCalled();

    querySpy.mockRestore();
  });

  it('increments consecutiveFailures and fires onError at the threshold when getClient throws', async () => {
    getClientSpy = spyOn(databaseConnectionManager, 'getClient').mockRejectedValue(
      new Error('db down'),
    );

    let errorFired = 0;
    statsPollService.subscribe(
      'docker',
      () => {},
      () => {
        errorFired += 1;
      },
    );

    const tick = harness.intervals[0].cb;

    // Threshold is 3 consecutive failures — first two ticks stay silent, the
    // third trips the onError callback exactly once.
    await tick();
    expect(errorFired).toBe(0);
    await tick();
    expect(errorFired).toBe(0);
    await tick();
    expect(errorFired).toBe(1);

    // Subsequent failures don't re-fire within the same failure episode.
    await tick();
    expect(errorFired).toBe(1);

    // And each failing tick logs via console.error, preserving existing behavior.
    expect(errorSpy).toHaveBeenCalled();
  });
});

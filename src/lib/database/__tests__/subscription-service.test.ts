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
    // Ensure polling state is fully reset between tests. The service is a
    // module-level singleton, so lingering subscribers would leak across cases.
    await statsPollService.stop();
    getClientSpy?.mockRestore();
    errorSpy.mockRestore();
    harness.restore();
  });

  it('rebuilds the repo per tick and queries the current pool after reconnect', async () => {
    const firstPool = createMockPool('pool-1');
    const secondPool = createMockPool('pool-2');

    const firstClient = createMockDbClient(firstPool.pool);
    const secondClient = createMockDbClient(secondPool.pool);

    // Spy on getPool so we can verify which client was used each tick.
    const firstGetPool = spyOn(firstClient, 'getPool');
    const secondGetPool = spyOn(secondClient, 'getPool');

    getClientSpy = spyOn(databaseConnectionManager, 'getClient')
      .mockResolvedValueOnce(firstClient as never)
      .mockResolvedValueOnce(secondClient as never);

    const querySpy = spyOn(StatsRepository.prototype, 'getDockerStatsSince').mockResolvedValue([]);

    statsPollService.subscribe('docker', () => {});

    expect(harness.intervals).toHaveLength(1);
    const tick = harness.intervals[0].cb;

    await tick();
    expect(firstGetPool).toHaveBeenCalledTimes(1);
    expect(secondGetPool).toHaveBeenCalledTimes(0);

    await tick();
    expect(firstGetPool).toHaveBeenCalledTimes(1);
    expect(secondGetPool).toHaveBeenCalledTimes(1);

    expect(getClientSpy).toHaveBeenCalledTimes(2);

    querySpy.mockRestore();
  });

  it('skips a tick while the previous poll for the source is still in flight', async () => {
    const pool = createMockPool('pool-inflight');
    const client = createMockDbClient(pool.pool);

    getClientSpy = spyOn(databaseConnectionManager, 'getClient').mockResolvedValue(client as never);

    // First poll's query hangs so the source stays "in flight" across ticks.
    let resolveQuery: (rows: never[]) => void = () => {};
    const querySpy = spyOn(StatsRepository.prototype, 'getDockerStatsSince').mockImplementation(
      () => new Promise<never[]>((resolve) => { resolveQuery = resolve; }),
    );

    statsPollService.subscribe('docker', () => {});
    const tick = harness.intervals[0].cb;

    const first = tick();
    // Let the first tick reach its awaited (hanging) query.
    await new Promise((r) => setTimeout(r, 0));

    // Second tick must early-return without starting another poll.
    await tick();
    expect(getClientSpy).toHaveBeenCalledTimes(1);
    expect(querySpy).toHaveBeenCalledTimes(1);

    resolveQuery([]);
    await first;

    querySpy.mockRestore();
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

    // Threshold is 3 consecutive failures: first two polls stay silent, the
    // third trips the onError callback exactly once. Backoff skips ticks
    // between polls, so advance until each poll actually runs.
    await ticksUntilNextPoll(tick, getClientSpy);
    expect(errorFired).toBe(0);
    await ticksUntilNextPoll(tick, getClientSpy);
    expect(errorFired).toBe(0);
    await ticksUntilNextPoll(tick, getClientSpy);
    expect(errorFired).toBe(1);

    // Subsequent failures don't re-fire within the same failure episode.
    await ticksUntilNextPoll(tick, getClientSpy);
    expect(errorFired).toBe(1);

    // And each failing poll logs via console.error, preserving existing behavior.
    expect(errorSpy).toHaveBeenCalled();
  });

  it('skips ticks with doubling backoff after failures and resets on success', async () => {
    const pool = createMockPool('pool-recover');
    const client = createMockDbClient(pool.pool);

    getClientSpy = spyOn(databaseConnectionManager, 'getClient')
      .mockRejectedValueOnce(new Error('db down'))
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue(client as never);
    const querySpy = spyOn(StatsRepository.prototype, 'getDockerStatsSince').mockResolvedValue([]);

    statsPollService.subscribe('docker', () => {});
    const tick = harness.intervals[0].cb;

    // Failure 1: effective spacing doubles to 2s, so 1 tick is skipped.
    await tick();
    expect(getClientSpy).toHaveBeenCalledTimes(1);
    await tick();
    expect(getClientSpy).toHaveBeenCalledTimes(1);

    // Failure 2: spacing doubles to 4s, so 3 ticks are skipped.
    await tick();
    expect(getClientSpy).toHaveBeenCalledTimes(2);
    await tick();
    await tick();
    await tick();
    expect(getClientSpy).toHaveBeenCalledTimes(2);

    // Next poll succeeds and resets the backoff.
    await tick();
    expect(getClientSpy).toHaveBeenCalledTimes(3);

    // Healthy again: every tick polls.
    await tick();
    expect(getClientSpy).toHaveBeenCalledTimes(4);
    await tick();
    expect(getClientSpy).toHaveBeenCalledTimes(5);

    querySpy.mockRestore();
  });

  it('caps the effective poll spacing at 10 ticks while the database stays down', async () => {
    getClientSpy = spyOn(databaseConnectionManager, 'getClient').mockRejectedValue(
      new Error('db down'),
    );

    statsPollService.subscribe('docker', () => {});
    const tick = harness.intervals[0].cb;

    const skips: number[] = [];
    for (let poll = 0; poll < 6; poll++) {
      skips.push(await ticksUntilNextPoll(tick, getClientSpy));
    }

    // First poll runs immediately; spacing then doubles (2s, 4s, 8s) and caps
    // at 10s, which means at most 9 skipped ticks between polls.
    expect(skips).toEqual([0, 1, 3, 7, 9, 9]);
  });
});

/**
 * Advance the polling tick until getClient is invoked again, returning how
 * many ticks were skipped by the backoff before the poll ran.
 */
async function ticksUntilNextPoll(
  tick: () => Promise<void> | void,
  getClientSpy: ReturnType<typeof spyOn>,
): Promise<number> {
  const before = getClientSpy.mock.calls.length;
  let skipped = 0;
  while (getClientSpy.mock.calls.length === before) {
    if (skipped > 20) throw new Error('no poll ran within 20 ticks');
    await tick();
    if (getClientSpy.mock.calls.length === before) skipped += 1;
  }
  return skipped;
}

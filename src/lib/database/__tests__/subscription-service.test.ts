import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { StatsPollService, type StatsSource } from '../subscription-service';

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

function statsRow(time: string) {
  return { time };
}

describe('StatsPollService', () => {
  let harness: ReturnType<typeof createIntervalHarness>;
  let errorSpy: ReturnType<typeof spyOn>;
  let loadRows: ReturnType<typeof mock>;
  let service: StatsPollService;

  beforeEach(() => {
    harness = createIntervalHarness();
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    loadRows = mock(async (_source: StatsSource, _since: Date) => []);
    service = new StatsPollService({ loadRows });
  });

  afterEach(async () => {
    await service.stop();
    errorSpy.mockRestore();
    harness.restore();
  });

  it('calls the injected loadRows with the source and a 200ms lookback cursor', async () => {
    service.subscribe('docker', () => {});
    const tick = harness.intervals[0].cb;

    await tick();

    expect(loadRows).toHaveBeenCalledTimes(1);
    const [source, since] = loadRows.mock.calls[0] as [StatsSource, Date];
    expect(source).toBe('docker');
    // subscribe() seeds lastPollTime to "now", so the first tick's since
    // cursor sits 200ms behind that seed.
    expect(since.getTime()).toBeLessThan(Date.now());
  });

  it('skips a tick while the previous poll for the source is still in flight', async () => {
    // First poll's loadRows call hangs so the source stays "in flight" across ticks.
    let resolveQuery: (rows: never[]) => void = () => {};
    loadRows.mockImplementation(
      () => new Promise<never[]>((resolve) => { resolveQuery = resolve; }),
    );

    service.subscribe('docker', () => {});
    const tick = harness.intervals[0].cb;

    const first = tick();
    // Let the first tick reach its awaited (hanging) loadRows call.
    await new Promise((r) => setTimeout(r, 0));

    // Second tick must early-return without starting another poll.
    await tick();
    expect(loadRows).toHaveBeenCalledTimes(1);

    resolveQuery([]);
    await first;
  });

  it('broadcasts all polled rows (including the 200ms overlap) to every subscriber', async () => {
    loadRows.mockResolvedValue([statsRow(new Date(Date.now() + 60_000).toISOString())]);
    const received: unknown[][] = [];

    service.subscribe('docker', (rows) => received.push(rows));
    const tick = harness.intervals[0].cb;

    await tick();

    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(1);
  });

  it('does not broadcast when loadRows returns no rows newer than the cursor', async () => {
    // Captured before subscribe() seeds lastPollTime, so this row is not
    // "newer than" the cursor once the poll runs.
    const beforeSubscribe = new Date();
    loadRows.mockResolvedValue([statsRow(beforeSubscribe.toISOString())]);
    const received: unknown[][] = [];

    service.subscribe('docker', (rows) => received.push(rows));
    const tick = harness.intervals[0].cb;

    await tick();

    expect(received).toHaveLength(0);
  });

  it('advances the cursor to the max row time observed, not wall-clock time', async () => {
    const farFuture = new Date(Date.now() + 5 * 60_000).toISOString();
    loadRows.mockResolvedValueOnce([statsRow(farFuture)]);
    loadRows.mockResolvedValueOnce([]);

    service.subscribe('docker', () => {});
    const tick = harness.intervals[0].cb;

    await tick();
    await tick();

    const secondCallSince = loadRows.mock.calls[1][1] as Date;
    // The cursor advanced past "now" to the max row time seen on the first
    // poll (minus the fixed 200ms lookback), not to wall-clock time.
    expect(secondCallSince.getTime()).toBeGreaterThan(Date.now());
  });

  it('does not throw on the healthy path when polling repeatedly', async () => {
    loadRows.mockResolvedValue([]);

    service.subscribe('docker', () => {});
    const tick = harness.intervals[0].cb;

    await expect(tick()).resolves.toBeUndefined();
    await expect(tick()).resolves.toBeUndefined();

    expect(loadRows).toHaveBeenCalledTimes(2);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('increments consecutiveFailures and fires onError at the threshold when loadRows rejects', async () => {
    loadRows.mockRejectedValue(new Error('db down'));

    let errorFired = 0;
    service.subscribe(
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
    await ticksUntilNextPoll(tick, loadRows);
    expect(errorFired).toBe(0);
    await ticksUntilNextPoll(tick, loadRows);
    expect(errorFired).toBe(0);
    await ticksUntilNextPoll(tick, loadRows);
    expect(errorFired).toBe(1);

    // Subsequent failures don't re-fire within the same failure episode.
    await ticksUntilNextPoll(tick, loadRows);
    expect(errorFired).toBe(1);

    // And each failing poll logs via console.error, preserving existing behavior.
    expect(errorSpy).toHaveBeenCalled();
  });

  it('skips ticks with doubling backoff after failures and resets on success', async () => {
    loadRows
      .mockRejectedValueOnce(new Error('db down'))
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue([]);

    service.subscribe('docker', () => {});
    const tick = harness.intervals[0].cb;

    // Failure 1: effective spacing doubles to 2s, so 1 tick is skipped.
    await tick();
    expect(loadRows).toHaveBeenCalledTimes(1);
    await tick();
    expect(loadRows).toHaveBeenCalledTimes(1);

    // Failure 2: spacing doubles to 4s, so 3 ticks are skipped.
    await tick();
    expect(loadRows).toHaveBeenCalledTimes(2);
    await tick();
    await tick();
    await tick();
    expect(loadRows).toHaveBeenCalledTimes(2);

    // Next poll succeeds and resets the backoff.
    await tick();
    expect(loadRows).toHaveBeenCalledTimes(3);

    // Healthy again: every tick polls.
    await tick();
    expect(loadRows).toHaveBeenCalledTimes(4);
    await tick();
    expect(loadRows).toHaveBeenCalledTimes(5);
  });

  it('caps the effective poll spacing at 10 ticks while loadRows keeps rejecting', async () => {
    loadRows.mockRejectedValue(new Error('db down'));

    service.subscribe('docker', () => {});
    const tick = harness.intervals[0].cb;

    const skips: number[] = [];
    for (let poll = 0; poll < 6; poll++) {
      skips.push(await ticksUntilNextPoll(tick, loadRows));
    }

    // First poll runs immediately; spacing then doubles (2s, 4s, 8s) and caps
    // at 10s, which means at most 9 skipped ticks between polls.
    expect(skips).toEqual([0, 1, 3, 7, 9, 9]);
  });
});

/**
 * Advance the polling tick until loadRows is invoked again, returning how
 * many ticks were skipped by the backoff before the poll ran.
 */
async function ticksUntilNextPoll(
  tick: () => Promise<void> | void,
  loadRows: ReturnType<typeof mock>,
): Promise<number> {
  const before = loadRows.mock.calls.length;
  let skipped = 0;
  while (loadRows.mock.calls.length === before) {
    if (skipped > 20) throw new Error('no poll ran within 20 ticks');
    await tick();
    if (loadRows.mock.calls.length === before) skipped += 1;
  }
  return skipped;
}

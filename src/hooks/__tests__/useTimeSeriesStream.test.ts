import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { z } from 'zod';
import { renderHook, act, waitFor } from '@testing-library/react';
import { mockModule } from '@/lib/test/mock-module';
import { FakeMuxConnection } from '@/lib/test/fake-mux';
import { mockSetInterval } from '@/lib/test/mock-timers';

const fakeMux = new FakeMuxConnection();
mockModule<typeof import('@/lib/mux/mux-connection')>('@/lib/mux/mux-connection', (real) => ({
  ...real,
  muxConnection: fakeMux,
}));

import { useTimeSeriesStream, VISIBILITY_REFRESH_COOLDOWN_MS } from '../useTimeSeriesStream';

const TOPIC = 'stats:test';

function simulateVisibilityChange(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, writable: true, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

interface TestRow {
  key: string;
  time: number;
  entity: string;
}

function makeRow(entity: string, timeOffset: number): TestRow {
  return { key: `${entity}-${timeOffset}`, time: Date.now() - timeOffset * 1000, entity };
}

const testSchema = z.array(z.object({ key: z.string(), time: z.number(), entity: z.string() }));

/** Test double: TestRow already carries a numeric `time`, so revive is the identity. */
const testChannel = {
  topic: TOPIC,
  schema: testSchema,
  revive: (rows: TestRow[]): TestRow[] => rows,
};

/** Same wire shape as `testChannel` but omits `revive`, matching the stats channels (docker/zfs/proxmox). */
const noReviveChannel = {
  topic: TOPIC,
  schema: testSchema,
};

const defaultOpts = {
  getKey: (r: TestRow) => r.key,
  getTime: (r: TestRow) => r.time,
  getEntity: (r: TestRow) => r.entity,
};

beforeEach(() => {
  fakeMux.subscriptions.clear();
  fakeMux.status = { connected: false, error: null };
});

/** Drops the shared mux connection and brings it back, firing onReconnect. */
function dropAndReopenConnection() {
  act(() => {
    fakeMux.setStatus({ connected: false, error: null });
    fakeMux.setStatus({ connected: true, error: null });
  });
}

describe('useTimeSeriesStream visibility refresh', () => {
  it('refreshes history when page becomes visible', async () => {
    const preloadFn = mock(() => Promise.resolve([makeRow('a', 10), makeRow('a', 5)]));

    renderHook(() =>
      useTimeSeriesStream({
        channel: testChannel,
        preloadFn,
        ...defaultOpts,
        windowSeconds: 60,
      })
    );

    // Wait for initial preload
    await waitFor(() => { expect(preloadFn).toHaveBeenCalledTimes(1); });

    // Advance past cooldown
    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() + VISIBILITY_REFRESH_COOLDOWN_MS + 100;

      act(() => simulateVisibilityChange('visible'));

      await waitFor(() => { expect(preloadFn).toHaveBeenCalledTimes(2); });
    } finally {
      Date.now = originalNow;
    }
  });

  it('skips refresh if last refresh was recent', async () => {
    const preloadFn = mock(() => Promise.resolve([makeRow('a', 10)]));

    renderHook(() =>
      useTimeSeriesStream({
        channel: testChannel,
        preloadFn,
        ...defaultOpts,
        windowSeconds: 60,
      })
    );

    await waitFor(() => { expect(preloadFn).toHaveBeenCalledTimes(1); });

    // cooldown check is synchronous; nothing to await
    act(() => simulateVisibilityChange('visible'));

    expect(preloadFn).toHaveBeenCalledTimes(1);
  });
});

describe('useTimeSeriesStream reconnect refresh', () => {
  it('refreshes history when the mux connection reopens after a drop', async () => {
    const preloadFn = mock(() => Promise.resolve([makeRow('a', 10)]));

    renderHook(() =>
      useTimeSeriesStream({
        channel: testChannel,
        preloadFn,
        ...defaultOpts,
        windowSeconds: 60,
      })
    );

    await waitFor(() => { expect(preloadFn).toHaveBeenCalledTimes(1); });

    // Advance past the shared refresh cooldown set by the initial preload
    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() + VISIBILITY_REFRESH_COOLDOWN_MS + 100;

      dropAndReopenConnection();

      await waitFor(() => { expect(preloadFn).toHaveBeenCalledTimes(2); });
    } finally {
      Date.now = originalNow;
    }
  });

  it('skips reconnect refresh when within the cooldown window', async () => {
    const preloadFn = mock(() => Promise.resolve([makeRow('a', 10)]));

    renderHook(() =>
      useTimeSeriesStream({
        channel: testChannel,
        preloadFn,
        ...defaultOpts,
        windowSeconds: 60,
      })
    );

    await waitFor(() => { expect(preloadFn).toHaveBeenCalledTimes(1); });

    // Reconnect immediately after preload: cooldown check is synchronous, so
    // the outcome is settled once this call returns.
    dropAndReopenConnection();

    expect(preloadFn).toHaveBeenCalledTimes(1);
  });

  it('paints the first frame after reconnect immediately even when the refresh is suppressed', async () => {
    // Huge interval so any paint must come from the immediate first-flush path,
    // not the periodic timer. Non-empty preload seeds lastRefreshRef so the
    // reconnect lands inside the cooldown and skips the re-preload.
    const preloadFn = mock(() => Promise.resolve([makeRow('seed', 5)]));

    const { result } = renderHook(() =>
      useTimeSeriesStream({
        channel: testChannel,
        preloadFn,
        ...defaultOpts,
        windowSeconds: 60,
        updateIntervalMs: 100_000,
      })
    );

    await waitFor(() => { expect(result.current.rows).toHaveLength(1); }); // seed only

    const now = Date.now();

    // First live frame paints immediately, arming the gate.
    act(() => { fakeMux.emitWire(TOPIC, 'data', [{ key: 'f1', time: now - 3000, entity: 'e' }]); });
    expect(result.current.rows).toHaveLength(2);

    // Second frame batches: the gate is closed and the interval effectively never fires.
    act(() => { fakeMux.emitWire(TOPIC, 'data', [{ key: 'f2', time: now - 2000, entity: 'e' }]); });
    expect(result.current.rows).toHaveLength(2);

    // Reconnect within cooldown: refresh is suppressed (synchronous check), but the gate must re-arm.
    dropAndReopenConnection();
    expect(preloadFn).toHaveBeenCalledTimes(1);

    // First frame after reconnect paints at once, draining the batched frame with it.
    act(() => { fakeMux.emitWire(TOPIC, 'data', [{ key: 'f3', time: now - 1000, entity: 'e' }]); });
    expect(result.current.rows.map(r => (r as { key: string }).key)).toEqual(['seed-5', 'f1', 'f2', 'f3']);
  });
});

describe('useTimeSeriesStream preload', () => {
  it('preloads data and returns sorted rows with hasData true', async () => {
    const rows = [makeRow('a', 10), makeRow('a', 5), makeRow('b', 8)];
    const preloadFn = mock(() => Promise.resolve(rows));

    const { result } = renderHook(() =>
      useTimeSeriesStream({
        channel: testChannel,
        preloadFn,
        ...defaultOpts,
        windowSeconds: 60,
      })
    );

    await waitFor(() => { expect(result.current.hasData).toBe(true); });

    expect(result.current.rows).toHaveLength(3);
    // Should be sorted ascending by time
    for (let i = 1; i < result.current.rows.length; i++) {
      expect(result.current.rows[i].time).toBeGreaterThanOrEqual(result.current.rows[i - 1].time);
    }
  });

  it('handles empty preload without setting hasData', async () => {
    const preloadFn = mock(() => Promise.resolve([]));

    const { result } = renderHook(() =>
      useTimeSeriesStream({
        channel: testChannel,
        preloadFn,
        ...defaultOpts,
      })
    );

    await waitFor(() => { expect(preloadFn).toHaveBeenCalledTimes(1); });
    // Empty preload never touches state; await the preload promise directly.
    await act(async () => { await preloadFn.mock.results[0]?.value; });

    expect(result.current.hasData).toBe(false);
    expect(result.current.rows).toHaveLength(0);
  });

  it('sets error on preload failure', async () => {
    const origError = console.error;
    console.error = mock(() => {});

    try {
      const preloadFn = mock(() => Promise.reject(new Error('DB down')));

      const { result } = renderHook(() =>
        useTimeSeriesStream({
          channel: testChannel,
          preloadFn,
          ...defaultOpts,
        })
      );

      await waitFor(() => { expect(result.current.error).not.toBeNull(); });

      expect(result.current.error?.message).toBe('DB down');
    } finally {
      console.error = origError;
    }
  });

  it('passes rows through unchanged (preload, initialData, and refresh) when the channel has no revive step', async () => {
    const now = Date.now();
    const staleInitialData: TestRow[] = [{ key: 'seed-1', time: now - 5000, entity: 'a' }];
    const preloadRows: TestRow[] = [{ key: 'fresh-1', time: now - 100, entity: 'a' }];
    const preloadFn = mock(() => Promise.resolve(preloadRows));

    const { result } = renderHook(() =>
      useTimeSeriesStream({
        channel: noReviveChannel,
        preloadFn,
        initialData: staleInitialData,
        ...defaultOpts,
        windowSeconds: 60,
      })
    );

    // initialData seeds synchronously through the no-revive path.
    expect(result.current.rows.map(r => r.key)).toEqual(['seed-1']);

    // Stale initialData schedules a refresh through the same no-revive path.
    await act(async () => {
      await waitFor(() => preloadFn.mock.calls.length > 0);
      await preloadFn.mock.results[0]?.value;
    });
    expect(preloadFn).toHaveBeenCalledTimes(1);
    expect(result.current.rows.map(r => r.key)).toContain('fresh-1');
  });

  it('computes latestByEntity map from preloaded rows', async () => {
    const now = Date.now();
    const rows: TestRow[] = [
      { key: 'a-1', time: now - 10000, entity: 'a' },
      { key: 'a-2', time: now - 5000, entity: 'a' },
      { key: 'b-1', time: now - 8000, entity: 'b' },
    ];
    const preloadFn = mock(() => Promise.resolve(rows));

    const { result } = renderHook(() =>
      useTimeSeriesStream({
        channel: testChannel,
        preloadFn,
        ...defaultOpts,
        windowSeconds: 60,
      })
    );

    await waitFor(() => { expect(result.current.latestByEntity.size).toBe(2); });

    expect(result.current.latestByEntity.get('a')?.key).toBe('a-2');
    expect(result.current.latestByEntity.get('b')?.key).toBe('b-1');
  });
});

describe('useTimeSeriesStream mux flush', () => {
  it('flushes mux messages into sorted rows', async () => {
    const preloadFn = mock(() => Promise.resolve([]));

    const { result } = renderHook(() =>
      useTimeSeriesStream({
        channel: testChannel,
        preloadFn,
        ...defaultOpts,
        windowSeconds: 60,
        updateIntervalMs: 50,
      })
    );

    await waitFor(() => { expect(preloadFn).toHaveBeenCalledTimes(1); });
    await act(async () => { await preloadFn.mock.results[0]?.value; });

    const now = Date.now();
    const liveRows: TestRow[] = [
      { key: 'x-1', time: now - 2000, entity: 'x' },
      { key: 'y-1', time: now - 1000, entity: 'y' },
    ];
    act(() => { fakeMux.emitWire(TOPIC, 'data', liveRows); });

    await waitFor(() => { expect(result.current.rows.length).toBeGreaterThanOrEqual(2); });
    expect(result.current.hasData).toBe(true);
  });

  it('deduplicates rows between preload and mux', async () => {
    const now = Date.now();
    const preloadRows: TestRow[] = [
      { key: 'a-1', time: now - 5000, entity: 'a' },
    ];
    const preloadFn = mock(() => Promise.resolve(preloadRows));

    const { result } = renderHook(() =>
      useTimeSeriesStream({
        channel: testChannel,
        preloadFn,
        ...defaultOpts,
        windowSeconds: 60,
        updateIntervalMs: 50,
      })
    );

    await waitFor(() => { expect(result.current.rows).toHaveLength(1); });

    // Mux sends same key + a new one
    const liveRows: TestRow[] = [
      { key: 'a-1', time: now - 5000, entity: 'a' }, // duplicate
      { key: 'a-2', time: now - 1000, entity: 'a' }, // new
    ];
    act(() => { fakeMux.emitWire(TOPIC, 'data', liveRows); });

    // Should have 2 rows (original + new), not 3
    await waitFor(() => { expect(result.current.rows).toHaveLength(2); });
  });

  it('evicts rows outside the time window', async () => {
    const now = Date.now();
    const preloadRows: TestRow[] = [
      { key: 'old', time: now - 120_000, entity: 'a' }, // 120s ago, outside 60s window
      { key: 'recent', time: now - 5000, entity: 'a' },
    ];
    const preloadFn = mock(() => Promise.resolve(preloadRows));

    const { result } = renderHook(() =>
      useTimeSeriesStream({
        channel: testChannel,
        preloadFn,
        ...defaultOpts,
        windowSeconds: 60,
        updateIntervalMs: 50,
      })
    );

    // Seed includes 'old' too: replaceBuffer's seed mode doesn't evict, only the
    // mux-driven flush below does.
    await waitFor(() => { expect(result.current.rows).toHaveLength(2); });

    // Send a new mux row to trigger flush (which also evicts)
    act(() => {
      fakeMux.emitWire(TOPIC, 'data', [{ key: 'new', time: now, entity: 'a' }]);
    });

    // The old row should have been evicted
    await waitFor(() => {
      const keys = result.current.rows.map(r => r.key);
      expect(keys).not.toContain('old');
      expect(keys).toContain('recent');
      expect(keys).toContain('new');
    });
  });

  it('clears preload error when mux data arrives', async () => {
    const origError = console.error;
    console.error = mock(() => {});

    try {
      let callCount = 0;
      const preloadFn = mock(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error('DB down'));
        return Promise.resolve([]);
      });

      const { result } = renderHook(() =>
        useTimeSeriesStream({
          channel: testChannel,
          preloadFn,
          ...defaultOpts,
          updateIntervalMs: 50,
        })
      );

      await waitFor(() => { expect(result.current.error?.message).toBe('DB down'); });

      // Mux data arrives: should clear the preload error
      const now = Date.now();
      act(() => {
        fakeMux.emitWire(TOPIC, 'data', [{ key: 'x-1', time: now, entity: 'x' }]);
      });

      await waitFor(() => { expect(result.current.error).toBeNull(); });
    } finally {
      console.error = origError;
    }
  });
});

describe('useTimeSeriesStream preload and delta merge', () => {
  it('merges preload history and live deltas with no duplicate points or zigzag', async () => {
    const now = Date.now();
    const preloadRows: TestRow[] = [
      { key: 'x-9', time: now - 9000, entity: 'x' },
      { key: 'x-7', time: now - 7000, entity: 'x' },
      { key: 'x-5', time: now - 5000, entity: 'x' },
    ];
    const preloadFn = mock(() => Promise.resolve(preloadRows));

    const { result } = renderHook(() =>
      useTimeSeriesStream({
        channel: testChannel,
        preloadFn,
        ...defaultOpts,
        windowSeconds: 60,
        updateIntervalMs: 50,
      })
    );
    await waitFor(() => { expect(result.current.rows).toHaveLength(3); });

    act(() => {
      fakeMux.emitWire(TOPIC, 'data', [
        { key: 'x-3', time: now - 3000, entity: 'x' },
        { key: 'x-5', time: now - 5000, entity: 'x' },
        { key: 'x-4', time: now - 4000, entity: 'x' },
      ]);
    });
    act(() => {
      fakeMux.emitWire(TOPIC, 'data', [
        { key: 'x-3', time: now - 3000, entity: 'x' },
        { key: 'x-2', time: now - 2000, entity: 'x' },
      ]);
    });

    await waitFor(() => { expect(result.current.rows).toHaveLength(6); });

    const rows = result.current.rows;
    expect(rows.map((r) => r.key)).toEqual(['x-9', 'x-7', 'x-5', 'x-4', 'x-3', 'x-2']);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].time).toBeGreaterThan(rows[i - 1].time);
    }
    expect(result.current.latestByEntity.get('x')?.key).toBe('x-2');
  });
});

describe('useTimeSeriesStream dropped frames', () => {
  it('surfaces a dropped frame as a visible gap count and marker, never silent', async () => {
    const preloadFn = mock(() => Promise.resolve([]));
    const { result } = renderHook(() =>
      useTimeSeriesStream({
        channel: testChannel,
        preloadFn,
        ...defaultOpts,
        windowSeconds: 60,
      })
    );

    await waitFor(() => { expect(preloadFn).toHaveBeenCalledTimes(1); });
    await act(async () => { await preloadFn.mock.results[0]?.value; });

    expect(result.current.dropCount).toBe(0);

    act(() => { fakeMux.emitDropped(TOPIC, 3); });

    expect(result.current.dropCount).toBe(3);
    expect(result.current.droppedEvents).toHaveLength(1);
    expect(result.current.droppedEvents[0]).toMatchObject({ topic: TOPIC, count: 3 });
    expect(result.current.droppedEvents[0].at).toBeGreaterThan(0);
  });

  it('accumulates drop counts across multiple dropped frames', async () => {
    const preloadFn = mock(() => Promise.resolve([]));
    const { result } = renderHook(() =>
      useTimeSeriesStream({
        channel: testChannel,
        preloadFn,
        ...defaultOpts,
        windowSeconds: 60,
      })
    );

    await waitFor(() => { expect(preloadFn).toHaveBeenCalledTimes(1); });
    await act(async () => { await preloadFn.mock.results[0]?.value; });

    act(() => {
      fakeMux.emitDropped(TOPIC, 2);
      fakeMux.emitDropped(TOPIC, 5);
    });

    expect(result.current.dropCount).toBe(7);
    expect(result.current.droppedEvents.map(e => e.count)).toEqual([2, 5]);
  });
});

describe('useTimeSeriesStream service error', () => {
  it('sets error when a service error frame is received', async () => {
    const preloadFn = mock(() => Promise.resolve([]));

    const { result } = renderHook(() =>
      useTimeSeriesStream({
        channel: testChannel,
        preloadFn,
        ...defaultOpts,
      })
    );

    await waitFor(() => { expect(preloadFn).toHaveBeenCalledTimes(1); });
    await act(async () => { await preloadFn.mock.results[0]?.value; });

    act(() => { fakeMux.emit(TOPIC, 'error', {}); });

    expect(result.current.error).not.toBeNull();
    expect(result.current.error?.message).toBe('Database unavailable');
  });
});

describe('useTimeSeriesStream periodic refresh', () => {
  it('re-fetches data at the configured refresh interval', async () => {
    const now = Date.now();
    const rows: TestRow[] = [{ key: 'a-1', time: now - 5000, entity: 'a' }];
    const preloadFn = mock(() => Promise.resolve(rows));
    const intervals = mockSetInterval();
    renderHook(() =>
      useTimeSeriesStream({
        channel: testChannel,
        preloadFn,
        ...defaultOpts,
        windowSeconds: 60,
        refreshIntervalMs: 100,
      })
    );
    // Restore before waitFor: it polls via setInterval and a captured poll never fires.
    const refreshTick = intervals.scheduled.find((t) => t.delayMs === 100)!;
    intervals.restore();

    // Wait for initial preload
    await waitFor(() => { expect(preloadFn).toHaveBeenCalledTimes(1); });

    await act(async () => { refreshTick.fn(); });
    expect(preloadFn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('doRefresh silently ignores errors', async () => {
    let callCount = 0;
    const preloadFn = mock(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([makeRow('a', 5)]);
      return Promise.reject(new Error('refresh failed'));
    });

    const intervals = mockSetInterval();
    const { result } = renderHook(() =>
      useTimeSeriesStream({
        channel: testChannel,
        preloadFn,
        ...defaultOpts,
        windowSeconds: 60,
        refreshIntervalMs: 100,
      })
    );
    // Restore before waitFor: it polls via setInterval and a captured poll never fires.
    const refreshTick = intervals.scheduled.find((t) => t.delayMs === 100)!;
    intervals.restore();

    await waitFor(() => { expect(result.current.hasData).toBe(true); });

    // Periodic refresh that fails must not propagate the error.
    await act(async () => { refreshTick.fn(); });
    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(result.current.rows.length).toBeGreaterThan(0);
  });
});

describe('useTimeSeriesStream stale initialData', () => {
  it('triggers a refresh when initialData is stale', async () => {
    const now = Date.now();
    // Rows older than STALE_INITIAL_DATA_MS (1500ms)
    const staleRows: TestRow[] = [
      { key: 'a-1', time: now - 5000, entity: 'a' },
      { key: 'b-1', time: now - 3000, entity: 'b' },
    ];
    const freshRows: TestRow[] = [
      { key: 'a-2', time: now - 500, entity: 'a' },
      { key: 'b-2', time: now - 200, entity: 'b' },
    ];
    const preloadFn = mock(() => Promise.resolve(freshRows));

    const { result } = renderHook(() =>
      useTimeSeriesStream({
        channel: testChannel,
        preloadFn,
        initialData: staleRows,
        ...defaultOpts,
        windowSeconds: 60,
      })
    );

    // initialData seeds immediately
    expect(result.current.hasData).toBe(true);
    expect(result.current.rows).toHaveLength(2);

    // Wait for the stale-data refresh (setTimeout 0 + preloadFn)
    await waitFor(() => { expect(preloadFn).toHaveBeenCalledTimes(1); });

    // preloadFn should have been called, and the buffer should now contain the fresh rows.
    await waitFor(() => {
      const keys = result.current.rows.map(r => r.key);
      expect(keys).toContain('a-2');
      expect(keys).toContain('b-2');
    });
  });

  it('does not refresh when initialData is fresh', async () => {
    const now = Date.now();
    // Rows within STALE_INITIAL_DATA_MS (1500ms)
    const freshRows: TestRow[] = [
      { key: 'a-1', time: now - 500, entity: 'a' },
    ];
    const preloadFn = mock(() => Promise.resolve([]));

    renderHook(() =>
      useTimeSeriesStream({
        channel: testChannel,
        preloadFn,
        initialData: freshRows,
        ...defaultOpts,
        windowSeconds: 60,
      })
    );

    // staleness check is synchronous; nothing to await
    expect(preloadFn).toHaveBeenCalledTimes(0);
  });
});

describe('useTimeSeriesStream cutoff-only eviction', () => {
  it('evicts old rows when the mux sends only duplicates', async () => {
    const now = Date.now();
    const preloadRows: TestRow[] = [
      { key: 'old', time: now - 120_000, entity: 'a' },
      { key: 'recent', time: now - 5000, entity: 'a' },
    ];
    const preloadFn = mock(() => Promise.resolve(preloadRows));

    const { result } = renderHook(() =>
      useTimeSeriesStream({
        channel: testChannel,
        preloadFn,
        ...defaultOpts,
        windowSeconds: 60,
        updateIntervalMs: 50,
      })
    );

    await waitFor(() => { expect(result.current.rows).toHaveLength(2); });

    // Send a duplicate row: triggers flush with pending > 0, but newRows is empty after dedup.
    // This exercises the cutoff-only branch (hasCutoff && !hasNew).
    act(() => {
      fakeMux.emitWire(TOPIC, 'data', [{ key: 'recent', time: now - 5000, entity: 'a' }]);
    });

    await waitFor(() => {
      const keys = result.current.rows.map(r => r.key);
      expect(keys).not.toContain('old');
      expect(keys).toContain('recent');
    });
  });
});

describe('useTimeSeriesStream latestByEntity stability', () => {
  it('returns the same Map reference when no entity latest changes', async () => {
    const now = Date.now();
    const preloadRows: TestRow[] = [
      { key: 'a-1', time: now - 10000, entity: 'a' },
      { key: 'b-1', time: now - 8000, entity: 'b' },
    ];
    const preloadFn = mock(() => Promise.resolve(preloadRows));

    const { result } = renderHook(() =>
      useTimeSeriesStream({
        channel: testChannel,
        preloadFn,
        ...defaultOpts,
        windowSeconds: 60,
        updateIntervalMs: 50,
      })
    );

    await waitFor(() => { expect(result.current.latestByEntity.size).toBe(2); });
    const firstMap = result.current.latestByEntity;

    // Send mux data for entity 'a' only - entity 'b' should keep the same row reference
    act(() => {
      fakeMux.emitWire(TOPIC, 'data', [{ key: 'a-2', time: now - 1000, entity: 'a' }]);
    });

    await waitFor(() => { expect(result.current.latestByEntity.get('a')?.key).toBe('a-2'); });
    const secondMap = result.current.latestByEntity;

    // But entity 'b' row reference should be the same object
    expect(secondMap.get('b')).toBe(firstMap.get('b'));
  });

  it('returns the same Map reference when a duplicate/older row is sent', async () => {
    const now = Date.now();
    const preloadRows: TestRow[] = [
      { key: 'a-1', time: now - 10000, entity: 'a' },
      { key: 'b-1', time: now - 8000, entity: 'b' },
    ];
    const preloadFn = mock(() => Promise.resolve(preloadRows));

    const { result } = renderHook(() =>
      useTimeSeriesStream({
        channel: testChannel,
        preloadFn,
        ...defaultOpts,
        windowSeconds: 60,
        updateIntervalMs: 50,
      })
    );

    await waitFor(() => { expect(result.current.latestByEntity.size).toBe(2); });
    const firstMap = result.current.latestByEntity;

    // Send a duplicate row (same key as existing): should be deduped, no latest change.
    act(() => {
      fakeMux.emitWire(TOPIC, 'data', [{ key: 'a-1', time: now - 10000, entity: 'a' }]);
    });

    // Map reference should be identical: no entity's latest changed
    await waitFor(() => { expect(result.current.latestByEntity).toBe(firstMap); });
  });
});

describe('useTimeSeriesStream preloadFn change', () => {
  it('re-fetches history when preloadFn changes and preserves in-flight mux live-tail', async () => {
    const now = Date.now();
    const firstFn = mock(() => Promise.resolve([{ key: 'a-1', time: now - 10_000, entity: 'a' }]));
    const secondFn = mock(() => Promise.resolve([{ key: 'a-1', time: now - 10_000, entity: 'a' }]));

    const { result, rerender } = renderHook(
      ({ fn }: { fn: () => Promise<TestRow[]> }) =>
        useTimeSeriesStream({
          channel: testChannel,
          preloadFn: fn,
          ...defaultOpts,
          windowSeconds: 60,
          updateIntervalMs: 30,
        }),
      { initialProps: { fn: firstFn } },
    );

    // Initial preload completes; buffer has 'a-1'.
    await waitFor(() => { expect(result.current.rows).toHaveLength(1); });
    expect(firstFn).toHaveBeenCalledTimes(1);

    // A mux row arrives that is newer than the (upcoming) refresh snapshot's max.
    act(() => {
      fakeMux.emitWire(TOPIC, 'data', [{ key: 'live', time: now + 5_000, entity: 'a' }]);
    });
    await waitFor(() => { expect(result.current.rows.map(r => r.key)).toContain('live'); });

    // Change preloadFn (e.g. window size changed via settings) → triggers a refresh, not a fresh seed.
    rerender({ fn: secondFn });
    await waitFor(() => { expect(secondFn).toHaveBeenCalledTimes(1); });

    // The live-tail row must survive the refresh; that's the preserveLiveTail contract.
    await waitFor(() => {
      const keys = result.current.rows.map(r => r.key);
      expect(keys).toContain('live');
      expect(keys).toContain('a-1');
    });
  });
});

describe('useTimeSeriesStream debug logging', () => {
  it('logs distinct messages for preload and refresh', async () => {
    const origLog = console.log;
    const messages: string[] = [];
    console.log = ((...args: unknown[]) => { messages.push(String(args[0] ?? '')); }) as typeof console.log;

    try {
      const preloadFn = mock(() => Promise.resolve([makeRow('a', 5)]));
      renderHook(() =>
        useTimeSeriesStream({
          channel: testChannel,
          preloadFn,
          ...defaultOpts,
          windowSeconds: 60,
          refreshIntervalMs: 40,
          debug: true,
        })
      );

      await waitFor(() => {
        expect(messages.some(m => m.includes('Buffer refresh'))).toBe(true);
      });

      expect(messages.some(m => m.includes('Starting preload'))).toBe(true);
      expect(messages.some(m => m.includes('Preload complete'))).toBe(true);
      // Refresh log carries the bucketed + liveTail = total breakdown restored from main.
      const refreshLog = messages.find(m => m.includes('Buffer refresh'));
      expect(refreshLog).toBeDefined();
      expect(refreshLog).toMatch(/\d+ bucketed \+ \d+ live = \d+ total/);
    } finally {
      console.log = origLog;
    }
  });
});

describe('useTimeSeriesStream error composition', () => {
  it('prefers serviceError over preloadError when both are present', async () => {
    const origError = console.error;
    console.error = mock(() => {});

    try {
      const preloadFn = mock(() => Promise.reject(new Error('DB down')));
      const { result } = renderHook(() =>
        useTimeSeriesStream({ channel: testChannel, preloadFn, ...defaultOpts }),
      );

      // Preload fails → preloadError is set
      await waitFor(() => { expect(result.current.error?.message).toBe('DB down'); });

      // Fire a service error frame. Composed error should switch to "Database unavailable".
      act(() => { fakeMux.emit(TOPIC, 'error', {}); });

      expect(result.current.error?.message).toBe('Database unavailable');
    } finally {
      console.error = origError;
    }
  });
});

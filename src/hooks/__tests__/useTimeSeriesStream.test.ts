import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { z } from 'zod';
import { renderHook, act } from '@testing-library/react';
import { useTimeSeriesStream, VISIBILITY_REFRESH_COOLDOWN_MS } from '../useTimeSeriesStream';
import { defineSseChannel } from '@/lib/sse/define-sse-channel';
import { MockEventSource } from '@/lib/test/mock-event-source';

const originalEventSource = globalThis.EventSource;

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

/** Test double for a stats channel descriptor: schema matches TestRow exactly, revive is the identity (TestRow already carries a numeric `time`). */
const testChannel = defineSseChannel({
  url: '/api/test',
  errorEvent: 'stats_error',
  schema: z.array(z.object({ key: z.string(), time: z.number(), entity: z.string() })),
  revive: (rows): TestRow[] => rows,
});

const defaultOpts = {
  getKey: (r: TestRow) => r.key,
  getTime: (r: TestRow) => r.time,
  getEntity: (r: TestRow) => r.entity,
};

beforeEach(() => {
  MockEventSource.reset();
  (globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).EventSource = originalEventSource;
});

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
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(preloadFn).toHaveBeenCalledTimes(1);

    // Advance past cooldown
    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() + VISIBILITY_REFRESH_COOLDOWN_MS + 100;

      act(() => simulateVisibilityChange('visible'));

      // Wait for async refresh
      await act(async () => { await new Promise(r => setTimeout(r, 50)); });
      expect(preloadFn).toHaveBeenCalledTimes(2);
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

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(preloadFn).toHaveBeenCalledTimes(1);

    // Immediately trigger visibility (within cooldown)
    act(() => simulateVisibilityChange('visible'));
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    // Should NOT have called preloadFn again
    expect(preloadFn).toHaveBeenCalledTimes(1);
  });
});

describe('useTimeSeriesStream reconnect refresh', () => {
  /** Errors the live SSE connection with timers firing synchronously, then opens the replacement. */
  async function dropAndReopenConnection() {
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      ((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout,
    );
    try {
      const es = MockEventSource.instances[MockEventSource.instances.length - 1];
      act(() => { es.onerror?.(); });
    } finally {
      setTimeoutSpy.mockRestore();
    }
    const reconnected = MockEventSource.instances[MockEventSource.instances.length - 1];
    // Single act scope so the async refresh kicked off by onReconnect settles inside it
    await act(async () => {
      reconnected.onopen?.();
      await new Promise(r => setTimeout(r, 50));
    });
  }

  it('refreshes history when the SSE connection reopens after a failure', async () => {
    const preloadFn = mock(() => Promise.resolve([makeRow('a', 10)]));

    renderHook(() =>
      useTimeSeriesStream({
        channel: testChannel,
        preloadFn,
        ...defaultOpts,
        windowSeconds: 60,
      })
    );

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(preloadFn).toHaveBeenCalledTimes(1);

    // Advance past the shared refresh cooldown set by the initial preload
    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() + VISIBILITY_REFRESH_COOLDOWN_MS + 100;

      await dropAndReopenConnection();

      expect(preloadFn).toHaveBeenCalledTimes(2);
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

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(preloadFn).toHaveBeenCalledTimes(1);

    // Reconnect immediately after preload: cooldown should suppress the refresh
    await dropAndReopenConnection();

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

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(result.current.rows).toHaveLength(1); // seed only

    const es = MockEventSource.instances[MockEventSource.instances.length - 1];
    const now = Date.now();

    // First live frame paints immediately, arming the gate.
    act(() => { es.onmessage?.({ data: JSON.stringify([{ key: 'f1', time: now - 3000, entity: 'e' }]) }); });
    expect(result.current.rows).toHaveLength(2);

    // Second frame batches: the gate is closed and the interval effectively never fires.
    act(() => { es.onmessage?.({ data: JSON.stringify([{ key: 'f2', time: now - 2000, entity: 'e' }]) }); });
    expect(result.current.rows).toHaveLength(2);

    // Reconnect within cooldown: refresh is suppressed, but the gate must re-arm.
    await dropAndReopenConnection();
    expect(preloadFn).toHaveBeenCalledTimes(1);

    // First frame after reconnect paints at once, draining the batched frame with it.
    const reconnected = MockEventSource.instances[MockEventSource.instances.length - 1];
    act(() => { reconnected.onmessage?.({ data: JSON.stringify([{ key: 'f3', time: now - 1000, entity: 'e' }]) }); });
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

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    expect(result.current.hasData).toBe(true);
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

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

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

      await act(async () => { await new Promise(r => setTimeout(r, 50)); });

      expect(result.current.error).not.toBeNull();
      expect(result.current.error?.message).toBe('DB down');
    } finally {
      console.error = origError;
    }
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

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    expect(result.current.latestByEntity.size).toBe(2);
    expect(result.current.latestByEntity.get('a')?.key).toBe('a-2');
    expect(result.current.latestByEntity.get('b')?.key).toBe('b-1');
  });
});

describe('useTimeSeriesStream SSE flush', () => {
  it('flushes SSE messages into sorted rows', async () => {
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

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    // Send data via SSE (useEventSource's onmessage handler parses JSON → calls handleData)
    const es = MockEventSource.instances[0];
    const now = Date.now();
    const sseRows: TestRow[] = [
      { key: 'x-1', time: now - 2000, entity: 'x' },
      { key: 'y-1', time: now - 1000, entity: 'y' },
    ];
    act(() => { es.onmessage?.({ data: JSON.stringify(sseRows) }); });

    // Wait for flush interval
    await act(async () => { await new Promise(r => setTimeout(r, 100)); });

    expect(result.current.rows.length).toBeGreaterThanOrEqual(2);
    expect(result.current.hasData).toBe(true);
  });

  it('deduplicates rows between preload and SSE', async () => {
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

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(result.current.rows).toHaveLength(1);

    // SSE sends same key + a new one
    const es = MockEventSource.instances[0];
    const sseRows: TestRow[] = [
      { key: 'a-1', time: now - 5000, entity: 'a' }, // duplicate
      { key: 'a-2', time: now - 1000, entity: 'a' }, // new
    ];
    act(() => { es.onmessage?.({ data: JSON.stringify(sseRows) }); });

    await act(async () => { await new Promise(r => setTimeout(r, 100)); });

    // Should have 2 rows (original + new), not 3
    expect(result.current.rows).toHaveLength(2);
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

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    // Send a new SSE row to trigger flush (which also evicts)
    const es = MockEventSource.instances[0];
    act(() => {
      es.onmessage?.({ data: JSON.stringify([{ key: 'new', time: now, entity: 'a' }]) });
    });

    await act(async () => { await new Promise(r => setTimeout(r, 100)); });

    // The old row should have been evicted
    const keys = result.current.rows.map(r => r.key);
    expect(keys).not.toContain('old');
    expect(keys).toContain('recent');
    expect(keys).toContain('new');
  });

  it('clears preload error when SSE data arrives', async () => {
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

      await act(async () => { await new Promise(r => setTimeout(r, 50)); });
      expect(result.current.error?.message).toBe('DB down');

      // SSE data arrives: should clear the preload error
      const es = MockEventSource.instances[0];
      const now = Date.now();
      act(() => {
        es.onmessage?.({ data: JSON.stringify([{ key: 'x-1', time: now, entity: 'x' }]) });
      });

      await act(async () => { await new Promise(r => setTimeout(r, 100)); });

      expect(result.current.error).toBeNull();
    } finally {
      console.error = origError;
    }
  });
});

describe('useTimeSeriesStream service error', () => {
  it('sets error when stats_error event is received', async () => {
    const preloadFn = mock(() => Promise.resolve([]));

    const { result } = renderHook(() =>
      useTimeSeriesStream({
        channel: testChannel,
        preloadFn,
        ...defaultOpts,
      })
    );

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    // Dispatch stats_error event on MockEventSource
    const es = MockEventSource.instances[0];
    act(() => { es.fireEvent('stats_error'); });

    expect(result.current.error).not.toBeNull();
    expect(result.current.error?.message).toBe('Database unavailable');
  });
});

describe('useTimeSeriesStream periodic refresh', () => {
  it('re-fetches data at the configured refresh interval', async () => {
    const now = Date.now();
    const rows: TestRow[] = [{ key: 'a-1', time: now - 5000, entity: 'a' }];
    const preloadFn = mock(() => Promise.resolve(rows));

    renderHook(() =>
      useTimeSeriesStream({
        channel: testChannel,
        preloadFn,
        ...defaultOpts,
        windowSeconds: 60,
        refreshIntervalMs: 100,
      })
    );

    // Wait for initial preload
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(preloadFn).toHaveBeenCalledTimes(1);

    // Wait for at least one periodic refresh
    await act(async () => { await new Promise(r => setTimeout(r, 150)); });
    expect(preloadFn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('doRefresh silently ignores errors', async () => {
    let callCount = 0;
    const preloadFn = mock(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([makeRow('a', 5)]);
      return Promise.reject(new Error('refresh failed'));
    });

    const { result } = renderHook(() =>
      useTimeSeriesStream({
        channel: testChannel,
        preloadFn,
        ...defaultOpts,
        windowSeconds: 60,
        refreshIntervalMs: 100,
      })
    );

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(result.current.hasData).toBe(true);

    // Wait for periodic refresh that fails
    await act(async () => { await new Promise(r => setTimeout(r, 150)); });

    // Error should not propagate; data should still be intact
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
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    // preloadFn should have been called, and the buffer should now contain the fresh rows.
    expect(preloadFn).toHaveBeenCalledTimes(1);
    const keys = result.current.rows.map(r => r.key);
    expect(keys).toContain('a-2');
    expect(keys).toContain('b-2');
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

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    // preloadFn should NOT have been called; initialData was fresh
    expect(preloadFn).toHaveBeenCalledTimes(0);
  });
});

describe('useTimeSeriesStream cutoff-only eviction', () => {
  it('evicts old rows when SSE sends only duplicates', async () => {
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

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(result.current.rows).toHaveLength(2);

    // Send a duplicate row: triggers flush with pending > 0, but newRows is empty after dedup.
    // This exercises the cutoff-only branch (hasCutoff && !hasNew).
    const es = MockEventSource.instances[0];
    act(() => {
      es.onmessage?.({ data: JSON.stringify([{ key: 'recent', time: now - 5000, entity: 'a' }]) });
    });

    await act(async () => { await new Promise(r => setTimeout(r, 100)); });

    const keys = result.current.rows.map(r => r.key);
    expect(keys).not.toContain('old');
    expect(keys).toContain('recent');
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

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    const firstMap = result.current.latestByEntity;
    expect(firstMap.size).toBe(2);

    // Send SSE data for entity 'a' only - entity 'b' should keep the same row reference
    const es = MockEventSource.instances[0];
    act(() => {
      es.onmessage?.({ data: JSON.stringify([{ key: 'a-2', time: now - 1000, entity: 'a' }]) });
    });

    await act(async () => { await new Promise(r => setTimeout(r, 100)); });
    const secondMap = result.current.latestByEntity;

    // Map reference changes (entity 'a' updated)
    expect(secondMap.get('a')?.key).toBe('a-2');
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

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    const firstMap = result.current.latestByEntity;
    expect(firstMap.size).toBe(2);

    // Send a duplicate row (same key as existing): should be deduped, no latest change
    const es = MockEventSource.instances[0];
    act(() => {
      es.onmessage?.({ data: JSON.stringify([{ key: 'a-1', time: now - 10000, entity: 'a' }]) });
    });

    await act(async () => { await new Promise(r => setTimeout(r, 100)); });

    // Map reference should be identical: no entity's latest changed
    expect(result.current.latestByEntity).toBe(firstMap);
  });
});

describe('useTimeSeriesStream preloadFn change', () => {
  it('re-fetches history when preloadFn changes and preserves in-flight SSE live-tail', async () => {
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
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(firstFn).toHaveBeenCalledTimes(1);
    expect(result.current.rows).toHaveLength(1);

    // An SSE row arrives that is newer than the (upcoming) refresh snapshot's max.
    const es = MockEventSource.instances[0];
    act(() => {
      es.onmessage?.({ data: JSON.stringify([{ key: 'live', time: now + 5_000, entity: 'a' }]) });
    });
    await act(async () => { await new Promise(r => setTimeout(r, 60)); });
    expect(result.current.rows.map(r => r.key)).toContain('live');

    // Change preloadFn (e.g. window size changed via settings) → triggers a refresh, not a fresh seed.
    rerender({ fn: secondFn });
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    expect(secondFn).toHaveBeenCalledTimes(1);
    // The live-tail row must survive the refresh; that's the preserveLiveTail contract.
    expect(result.current.rows.map(r => r.key)).toContain('live');
    expect(result.current.rows.map(r => r.key)).toContain('a-1');
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

      await act(async () => { await new Promise(r => setTimeout(r, 150)); });

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
      await act(async () => { await new Promise(r => setTimeout(r, 50)); });
      expect(result.current.error?.message).toBe('DB down');

      // Fire stats_error → serviceError is set. Composed error should switch to "Database unavailable".
      const es = MockEventSource.instances[0];
      act(() => { es.fireEvent('stats_error'); });

      expect(result.current.error?.message).toBe('Database unavailable');
    } finally {
      console.error = origError;
    }
  });
});

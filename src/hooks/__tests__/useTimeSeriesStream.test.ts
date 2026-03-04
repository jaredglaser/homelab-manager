import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useTimeSeriesStream, VISIBILITY_REFRESH_COOLDOWN_MS } from '../useTimeSeriesStream';

// MockEventSource with listener support for stats_error dispatch
class MockEventSource {
  static instances: MockEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((event: unknown) => void)[]>();
  readyState = 0;

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  constructor(_url: string) { MockEventSource.instances.push(this); }

  addEventListener(type: string, handler: (event: unknown) => void) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type: string, handler: (event: unknown) => void) {
    const handlers = this.listeners.get(type) ?? [];
    this.listeners.set(type, handlers.filter(h => h !== handler));
  }

  fireEvent(type: string) {
    const handlers = this.listeners.get(type) ?? [];
    for (const h of handlers) h({});
  }

  close() { this.readyState = 2; }
  static reset() { MockEventSource.instances = []; }
}

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
        sseUrl: '/api/test',
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
        sseUrl: '/api/test',
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

describe('useTimeSeriesStream preload', () => {
  it('preloads data and returns sorted rows with hasData true', async () => {
    const rows = [makeRow('a', 10), makeRow('a', 5), makeRow('b', 8)];
    const preloadFn = mock(() => Promise.resolve(rows));

    const { result } = renderHook(() =>
      useTimeSeriesStream({
        sseUrl: '/api/test',
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
        sseUrl: '/api/test',
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
          sseUrl: '/api/test',
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
        sseUrl: '/api/test',
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
        sseUrl: '/api/test',
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
        sseUrl: '/api/test',
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
        sseUrl: '/api/test',
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
          sseUrl: '/api/test',
          preloadFn,
          ...defaultOpts,
          updateIntervalMs: 50,
        })
      );

      await act(async () => { await new Promise(r => setTimeout(r, 50)); });
      expect(result.current.error?.message).toBe('DB down');

      // SSE data arrives — should clear the preload error
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
        sseUrl: '/api/test',
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
        sseUrl: '/api/test',
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
        sseUrl: '/api/test',
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

    // Error should not propagate — data should still be intact
    expect(result.current.rows.length).toBeGreaterThan(0);
  });
});

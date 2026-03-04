import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useTimeSeriesStream, VISIBILITY_REFRESH_COOLDOWN_MS } from '../useTimeSeriesStream';

// Minimal MockEventSource for useEventSource dependency
class MockEventSource {
  static instances: MockEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  constructor(_url: string) { MockEventSource.instances.push(this); }
  addEventListener() {}
  removeEventListener() {}
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
        getKey: (r: TestRow) => r.key,
        getTime: (r: TestRow) => r.time,
        getEntity: (r: TestRow) => r.entity,
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
        getKey: (r: TestRow) => r.key,
        getTime: (r: TestRow) => r.time,
        getEntity: (r: TestRow) => r.entity,
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

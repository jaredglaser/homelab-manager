import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useEventSource } from '../useEventSource';
import { MockEventSource } from '@/lib/test/mock-event-source';

const originalEventSource = globalThis.EventSource;

beforeEach(() => {
  MockEventSource.reset();
  (globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).EventSource = originalEventSource;
});

function simulateVisibilityChange(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, writable: true, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useEventSource', () => {
  it('reconnects when page becomes visible after connection errored out', () => {
    const origSetTimeout = globalThis.setTimeout;
    (globalThis as unknown as Record<string, unknown>).setTimeout = ((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout;
    try {
      const { result } = renderHook(() =>
        useEventSource({ url: '/api/test', onData: () => {} })
      );

      const es = MockEventSource.instances[0];

      // Exhaust reconnect attempts (5 errors)
      act(() => { for (let i = 0; i < 5; i++) es.onerror?.(); });

      expect(result.current.error).not.toBeNull();

      // Tab becomes visible — should create a new connection
      act(() => simulateVisibilityChange('visible'));

      expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(2);
      expect(MockEventSource.instances[MockEventSource.instances.length - 1].closed).toBe(false);
    } finally {
      (globalThis as unknown as Record<string, unknown>).setTimeout = origSetTimeout;
    }
  });

  it('does not reconnect on visibility change when already connected', () => {
    renderHook(() =>
      useEventSource({ url: '/api/test', onData: () => {} })
    );

    const es = MockEventSource.instances[0];
    act(() => { es.onopen?.(); });

    act(() => simulateVisibilityChange('visible'));

    // Should still only have the original connection
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it('resets error state on visibility-triggered reconnect', () => {
    const origSetTimeout = globalThis.setTimeout;
    (globalThis as unknown as Record<string, unknown>).setTimeout = ((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout;
    try {
      const { result } = renderHook(() =>
        useEventSource({ url: '/api/test', onData: () => {} })
      );

      const es = MockEventSource.instances[0];
      act(() => { for (let i = 0; i < 5; i++) es.onerror?.(); });
      expect(result.current.error).not.toBeNull();

      act(() => simulateVisibilityChange('visible'));

      const newEs = MockEventSource.instances[MockEventSource.instances.length - 1];
      act(() => { newEs.onopen?.(); });

      expect(result.current.error).toBeNull();
      expect(result.current.isConnected).toBe(true);
    } finally {
      (globalThis as unknown as Record<string, unknown>).setTimeout = origSetTimeout;
    }
  });

  it('parses JSON messages and calls onData', () => {
    const onData = mock(() => {});
    renderHook(() => useEventSource({ url: '/api/test', onData }));

    const es = MockEventSource.instances[0];
    act(() => { es.onopen?.(); });
    act(() => { es.onmessage?.({ data: JSON.stringify({ value: 42 }) }); });

    expect(onData).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenCalledWith({ value: 42 });
  });

  it('handles array messages', () => {
    const onData = mock(() => {});
    renderHook(() => useEventSource({ url: '/api/test', onData }));

    const es = MockEventSource.instances[0];
    act(() => { es.onopen?.(); });
    act(() => { es.onmessage?.({ data: JSON.stringify([1, 2, 3]) }); });

    expect(onData).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('handles JSON parse errors without crashing', () => {
    const onData = mock(() => {});
    const origError = console.error;
    console.error = mock(() => {});

    try {
      renderHook(() => useEventSource({ url: '/api/test', onData }));

      const es = MockEventSource.instances[0];
      act(() => { es.onopen?.(); });
      act(() => { es.onmessage?.({ data: 'not-valid-json' }); });

      expect(onData).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalled();
    } finally {
      console.error = origError;
    }
  });

  it('calls onServiceError when stats_error event is received', () => {
    const onServiceError = mock(() => {});
    renderHook(() =>
      useEventSource({ url: '/api/test', onData: () => {}, onServiceError })
    );

    const es = MockEventSource.instances[0];
    act(() => { es.onopen?.(); });
    act(() => { es.fireEvent('stats_error'); });

    expect(onServiceError).toHaveBeenCalledTimes(1);
  });

  it('tracks isConnected state on open and error', () => {
    const origSetTimeout = globalThis.setTimeout;
    (globalThis as unknown as Record<string, unknown>).setTimeout = ((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout;
    try {
      const { result } = renderHook(() =>
        useEventSource({ url: '/api/test', onData: () => {} })
      );

      expect(result.current.isConnected).toBe(false);

      const es = MockEventSource.instances[0];
      act(() => { es.onopen?.(); });
      expect(result.current.isConnected).toBe(true);

      act(() => { es.onerror?.(); });
      expect(result.current.isConnected).toBe(false);
    } finally {
      (globalThis as unknown as Record<string, unknown>).setTimeout = origSetTimeout;
    }
  });

  it('does not reconnect when visibility changes to hidden', () => {
    const origSetTimeout = globalThis.setTimeout;
    (globalThis as unknown as Record<string, unknown>).setTimeout = ((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout;
    try {
      renderHook(() =>
        useEventSource({ url: '/api/test', onData: () => {} })
      );

      const es = MockEventSource.instances[0];
      act(() => { for (let i = 0; i < 5; i++) es.onerror?.(); });

      act(() => simulateVisibilityChange('hidden'));

      // After exhausting attempts, no more reconnects should happen on hidden
      // (instances may be > 1 due to backoff retries with immediate setTimeout, but no new ones after hidden)
      const countAfterErrors = MockEventSource.instances.length;
      act(() => simulateVisibilityChange('hidden'));
      expect(MockEventSource.instances).toHaveLength(countAfterErrors);
    } finally {
      (globalThis as unknown as Record<string, unknown>).setTimeout = origSetTimeout;
    }
  });

  it('processes multiple messages sequentially', () => {
    const received: unknown[] = [];
    const onData = mock((data: unknown) => { received.push(data); });
    renderHook(() => useEventSource({ url: '/api/test', onData }));

    const es = MockEventSource.instances[0];
    act(() => { es.onopen?.(); });
    act(() => {
      es.onmessage?.({ data: JSON.stringify({ id: 1 }) });
      es.onmessage?.({ data: JSON.stringify({ id: 2 }) });
      es.onmessage?.({ data: JSON.stringify({ id: 3 }) });
    });

    expect(onData).toHaveBeenCalledTimes(3);
    expect(received).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it('closes EventSource on error and creates new connection on retry', () => {
    const origSetTimeout = globalThis.setTimeout;
    (globalThis as unknown as Record<string, unknown>).setTimeout = ((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout;
    try {
      renderHook(() => useEventSource({ url: '/api/test', onData: () => {} }));
      const es1 = MockEventSource.instances[0];
      act(() => { es1.onerror?.(); });
      expect(MockEventSource.instances).toHaveLength(2);
      expect(es1.closed).toBe(true);
      expect(MockEventSource.instances[1].closed).toBe(false);
    } finally {
      (globalThis as unknown as Record<string, unknown>).setTimeout = origSetTimeout;
    }
  });
});

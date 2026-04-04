import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
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
  describe('with immediate timers', () => {
    let setTimeoutSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout);
    });

    afterEach(() => {
      setTimeoutSpy.mockRestore();
    });

    it('reconnects when page becomes visible after connection errored out', () => {
      const { result } = renderHook(() =>
        useEventSource({ url: '/api/test', onData: () => {} })
      );

      // Exhaust reconnect attempts — error on the latest instance each time
      // since stale instances are correctly ignored after reconnection
      act(() => {
        for (let i = 0; i <= 5; i++) {
          const latest = MockEventSource.instances[MockEventSource.instances.length - 1];
          latest.onerror?.();
        }
      });

      expect(result.current.error).not.toBeNull();

      // Tab becomes visible — should create a new connection
      act(() => simulateVisibilityChange('visible'));

      expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(2);
      expect(MockEventSource.instances[MockEventSource.instances.length - 1].closed).toBe(false);
    });

    it('resets error state on visibility-triggered reconnect', () => {
      const { result } = renderHook(() =>
        useEventSource({ url: '/api/test', onData: () => {} })
      );

      act(() => {
        for (let i = 0; i <= 5; i++) {
          const latest = MockEventSource.instances[MockEventSource.instances.length - 1];
          latest.onerror?.();
        }
      });
      expect(result.current.error).not.toBeNull();

      act(() => simulateVisibilityChange('visible'));

      const newEs = MockEventSource.instances[MockEventSource.instances.length - 1];
      act(() => { newEs.onopen?.(); });

      expect(result.current.error).toBeNull();
      expect(result.current.isConnected).toBe(true);
    });

    it('tracks isConnected state on open and error', () => {
      const { result } = renderHook(() =>
        useEventSource({ url: '/api/test', onData: () => {} })
      );

      expect(result.current.isConnected).toBe(false);

      const es = MockEventSource.instances[0];
      act(() => { es.onopen?.(); });
      expect(result.current.isConnected).toBe(true);

      act(() => { es.onerror?.(); });
      expect(result.current.isConnected).toBe(false);
    });

    it('does not reconnect when visibility changes to hidden', () => {
      renderHook(() =>
        useEventSource({ url: '/api/test', onData: () => {} })
      );

      act(() => {
        for (let i = 0; i <= 5; i++) {
          const latest = MockEventSource.instances[MockEventSource.instances.length - 1];
          latest.onerror?.();
        }
      });

      act(() => simulateVisibilityChange('hidden'));

      // After exhausting attempts, no more reconnects should happen on hidden
      const countAfterErrors = MockEventSource.instances.length;
      act(() => simulateVisibilityChange('hidden'));
      expect(MockEventSource.instances).toHaveLength(countAfterErrors);
    });

    it('closes EventSource on error and creates new connection on retry', () => {
      renderHook(() => useEventSource({ url: '/api/test', onData: () => {} }));
      const es1 = MockEventSource.instances[0];
      act(() => { es1.onerror?.(); });
      expect(MockEventSource.instances).toHaveLength(2);
      expect(es1.closed).toBe(true);
      expect(MockEventSource.instances[1].closed).toBe(false);
    });

    it('resets retry budget and error state when url changes', () => {
      const { result, rerender } = renderHook(
        ({ url }) => useEventSource({ url, onData: () => {} }),
        { initialProps: { url: '/api/first' } },
      );

      // Exhaust retry attempts on the first URL
      act(() => {
        for (let i = 0; i <= 5; i++) {
          const latest = MockEventSource.instances[MockEventSource.instances.length - 1];
          latest.onerror?.();
        }
      });
      expect(result.current.error).not.toBeNull();

      // Switch to a new URL — should reset error and create a fresh connection
      act(() => { rerender({ url: '/api/second' }); });

      expect(result.current.error).toBeNull();
      const latest = MockEventSource.instances[MockEventSource.instances.length - 1];
      expect(latest.url).toBe('/api/second');
      expect(latest.closed).toBe(false);
    });
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

});

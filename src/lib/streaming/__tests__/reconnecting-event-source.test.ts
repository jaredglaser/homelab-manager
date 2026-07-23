import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { createReconnectingEventSource } from '@/lib/streaming/reconnecting-event-source';
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

describe('createReconnectingEventSource', () => {
  it('connects to the given url on creation', () => {
    createReconnectingEventSource({
      url: '/api/test',
      onOpen: () => {},
      onMessage: () => {},
      onError: () => {},
    });

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe('/api/test');
  });

  it('calls onOpen when the connection opens and onMessage for default messages', () => {
    const onOpen = mock(() => {});
    const onMessage = mock(() => {});
    createReconnectingEventSource({ url: '/api/test', onOpen, onMessage, onError: () => {} });

    const es = MockEventSource.instances[0];
    es.onopen?.();
    es.onmessage?.({ data: 'payload' });

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({ data: 'payload' });
  });

  it('forwards named events with the raw browser event', () => {
    const onNamedEvent = mock(() => {});
    createReconnectingEventSource({
      url: '/api/test',
      onOpen: () => {},
      onMessage: () => {},
      onError: () => {},
      namedEvents: ['custom_event'],
      onNamedEvent,
    });

    MockEventSource.instances[0].fireEvent('custom_event', { data: 'hello' });

    expect(onNamedEvent).toHaveBeenCalledWith('custom_event', { data: 'hello' });
  });

  describe('with immediate timers', () => {
    let setTimeoutSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout);
    });

    afterEach(() => {
      setTimeoutSpy.mockRestore();
    });

    it('reconnects with exponential backoff capped at 16s', () => {
      const delays: number[] = [];
      setTimeoutSpy.mockImplementation(((fn: () => void, delay?: number) => {
        delays.push(delay ?? 0);
        fn();
        return 0;
      }) as unknown as typeof setTimeout);

      createReconnectingEventSource({ url: '/api/test', onOpen: () => {}, onMessage: () => {}, onError: () => {} });

      for (let i = 0; i < 7; i++) {
        MockEventSource.instances[MockEventSource.instances.length - 1].onerror?.();
      }

      expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 16_000, 16_000]);
    });

    it('retries indefinitely when maxAttempts is not set', () => {
      createReconnectingEventSource({ url: '/api/test', onOpen: () => {}, onMessage: () => {}, onError: () => {} });

      for (let i = 0; i < 10; i++) {
        MockEventSource.instances[MockEventSource.instances.length - 1].onerror?.();
      }

      expect(MockEventSource.instances).toHaveLength(11);
      expect(MockEventSource.instances[MockEventSource.instances.length - 1].closed).toBe(false);
    });

    it('stops retrying and calls onGiveUp once maxAttempts is exceeded', () => {
      const onGiveUp = mock(() => {});
      createReconnectingEventSource({
        url: '/api/test',
        onOpen: () => {},
        onMessage: () => {},
        onError: () => {},
        maxAttempts: 5,
        onGiveUp,
      });

      // Initial failure + 5 retry failures = 6 onerror calls before giving up.
      for (let i = 0; i < 6; i++) {
        MockEventSource.instances[MockEventSource.instances.length - 1].onerror?.();
      }

      expect(onGiveUp).toHaveBeenCalledTimes(1);
      expect(MockEventSource.instances).toHaveLength(6);

      // Must not fire again on a further failure.
      MockEventSource.instances[MockEventSource.instances.length - 1].onerror?.();
      expect(onGiveUp).toHaveBeenCalledTimes(1);
    });

    it('calls onErrorThreshold once the threshold is crossed without stopping retries', () => {
      const onErrorThreshold = mock(() => {});
      createReconnectingEventSource({
        url: '/api/test',
        onOpen: () => {},
        onMessage: () => {},
        onError: () => {},
        errorThreshold: 5,
        onErrorThreshold,
      });

      for (let i = 0; i < 5; i++) {
        MockEventSource.instances[MockEventSource.instances.length - 1].onerror?.();
      }
      expect(onErrorThreshold).not.toHaveBeenCalled();

      MockEventSource.instances[MockEventSource.instances.length - 1].onerror?.();
      expect(onErrorThreshold).toHaveBeenCalledTimes(1);
      // Retries keep going past the threshold.
      expect(MockEventSource.instances).toHaveLength(7);
    });

    it('suppresses retry scheduling when onError returns false', () => {
      let streamEnded = false;
      createReconnectingEventSource({
        url: '/api/test',
        onOpen: () => {},
        onMessage: () => {},
        onError: () => {
          if (streamEnded) return false;
        },
        namedEvents: ['stream_end'],
        onNamedEvent: (name) => { if (name === 'stream_end') streamEnded = true; },
      });

      MockEventSource.instances[0].fireEvent('stream_end', {});
      MockEventSource.instances[0].onerror?.();

      expect(MockEventSource.instances).toHaveLength(1);
    });

    it('resets the attempt counter after a successful reconnect', () => {
      const delays: number[] = [];
      setTimeoutSpy.mockImplementation(((fn: () => void, delay?: number) => {
        delays.push(delay ?? 0);
        fn();
        return 0;
      }) as unknown as typeof setTimeout);

      createReconnectingEventSource({ url: '/api/test', onOpen: () => {}, onMessage: () => {}, onError: () => {} });

      MockEventSource.instances[0].onerror?.();
      MockEventSource.instances[MockEventSource.instances.length - 1].onerror?.();
      expect(delays).toEqual([1_000, 2_000]);

      MockEventSource.instances[MockEventSource.instances.length - 1].onopen?.();
      MockEventSource.instances[MockEventSource.instances.length - 1].onerror?.();

      expect(delays[delays.length - 1]).toBe(1_000);
    });
  });

  describe('visibility and online reconnect', () => {
    it('does not reconnect on visibility or online events unless opted in', () => {
      const spy = spyOn(globalThis, 'setTimeout').mockImplementation((() => 0) as unknown as typeof setTimeout);
      try {
        createReconnectingEventSource({ url: '/api/test', onOpen: () => {}, onMessage: () => {}, onError: () => {} });

        MockEventSource.instances[0].onerror?.();
        simulateVisibilityChange('visible');
        window.dispatchEvent(new Event('online'));

        expect(MockEventSource.instances).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
    });

    it('reconnects when the tab becomes visible while disconnected and idle', () => {
      // maxAttempts: 0 is the only way to reach idle (no connection, no pending timer); indefinite retry always has a timer pending.
      createReconnectingEventSource({
        url: '/api/test',
        onOpen: () => {},
        onMessage: () => {},
        onError: () => {},
        maxAttempts: 0,
        reconnectOnVisibility: true,
      });

      MockEventSource.instances[0].onerror?.();
      expect(MockEventSource.instances).toHaveLength(1);

      simulateVisibilityChange('visible');

      expect(MockEventSource.instances).toHaveLength(2);
    });

    it('does not reconnect on visibility change while already connected', () => {
      createReconnectingEventSource({
        url: '/api/test',
        onOpen: () => {},
        onMessage: () => {},
        onError: () => {},
        reconnectOnVisibility: true,
      });

      MockEventSource.instances[0].onopen?.();
      simulateVisibilityChange('visible');

      expect(MockEventSource.instances).toHaveLength(1);
    });

    it('reconnects immediately on online event, skipping remaining backoff', () => {
      const spy = spyOn(globalThis, 'setTimeout').mockImplementation((() => 0) as unknown as typeof setTimeout);
      try {
        createReconnectingEventSource({
          url: '/api/test',
          onOpen: () => {},
          onMessage: () => {},
          onError: () => {},
          reconnectOnOnline: true,
        });

        MockEventSource.instances[0].onerror?.();
        expect(MockEventSource.instances).toHaveLength(1);

        window.dispatchEvent(new Event('online'));

        expect(MockEventSource.instances).toHaveLength(2);
        expect(MockEventSource.instances[1].closed).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it('ignores online event while connected', () => {
      createReconnectingEventSource({
        url: '/api/test',
        onOpen: () => {},
        onMessage: () => {},
        onError: () => {},
        reconnectOnOnline: true,
      });

      MockEventSource.instances[0].onopen?.();
      window.dispatchEvent(new Event('online'));

      expect(MockEventSource.instances).toHaveLength(1);
    });
  });

  describe('dispose', () => {
    it('closes the connection and stops further reconnects', () => {
      const onOpen = mock(() => {});
      const handle = createReconnectingEventSource({ url: '/api/test', onOpen, onMessage: () => {}, onError: () => {} });

      const es = MockEventSource.instances[0];
      handle.dispose();

      expect(es.closed).toBe(true);

      es.onopen?.();
      expect(onOpen).not.toHaveBeenCalled();
    });

    it('cancels a pending reconnect timer', () => {
      const setTimeoutSpy = spyOn(globalThis, 'setTimeout');
      const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout');
      try {
        const handle = createReconnectingEventSource({ url: '/api/test', onOpen: () => {}, onMessage: () => {}, onError: () => {} });

        MockEventSource.instances[0].onerror?.();
        expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

        handle.dispose();

        expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
      } finally {
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
      }
    });

    it('removes visibility and online listeners', () => {
      const removeDocSpy = spyOn(document, 'removeEventListener');
      const removeWinSpy = spyOn(window, 'removeEventListener');
      try {
        const handle = createReconnectingEventSource({
          url: '/api/test',
          onOpen: () => {},
          onMessage: () => {},
          onError: () => {},
          reconnectOnVisibility: true,
          reconnectOnOnline: true,
        });

        handle.dispose();

        expect(removeDocSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
        expect(removeWinSpy).toHaveBeenCalledWith('online', expect.any(Function));
      } finally {
        removeDocSpy.mockRestore();
        removeWinSpy.mockRestore();
      }
    });
  });
});

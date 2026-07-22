import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { z } from 'zod';
import { renderHook, act } from '@testing-library/react';
import { MockEventSource } from '@/lib/test/mock-event-source';
import { useSseChannel } from '../useSseChannel';
import { defineSseChannel } from '@/lib/sse/define-sse-channel';

const originalEventSource = globalThis.EventSource;

beforeEach(() => {
  MockEventSource.reset();
  (globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).EventSource = originalEventSource;
});

const testChannel = defineSseChannel({
  url: '/api/test-channel',
  errorEvent: 'test_channel_error',
  schema: z.object({ value: z.number() }),
  revive: (raw) => ({ doubled: raw.value * 2 }),
});

describe('useSseChannel', () => {
  it('connects to apiUrl(channel.url)', () => {
    renderHook(() => useSseChannel(testChannel, { onData: () => {} }));

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe('/api/test-channel');
  });

  it('parses and revives valid messages before calling onData', () => {
    const onData = mock(() => {});
    renderHook(() => useSseChannel(testChannel, { onData }));

    const es = MockEventSource.instances[0];
    act(() => {
      es.onopen?.();
      es.onmessage?.({ data: JSON.stringify({ value: 21 }) });
    });

    expect(onData).toHaveBeenCalledWith({ doubled: 42 });
  });

  it('drops a message that fails schema validation and logs, without calling onData', () => {
    const onData = mock(() => {});
    const origError = console.error;
    console.error = mock(() => {});

    try {
      renderHook(() => useSseChannel(testChannel, { onData }));
      const es = MockEventSource.instances[0];

      act(() => {
        es.onopen?.();
        es.onmessage?.({ data: JSON.stringify({ value: 'not-a-number' }) });
      });

      expect(onData).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalled();
    } finally {
      console.error = origError;
    }
  });

  it('listens for the channel-specific error event name', () => {
    const { result } = renderHook(() => useSseChannel(testChannel, { onData: () => {} }));
    const es = MockEventSource.instances[0];

    act(() => { es.onopen?.(); });
    act(() => { es.fireEvent('test_channel_error'); });

    expect(result.current.error).not.toBeNull();
    expect(result.current.error?.message).toBe('/api/test-channel stream unavailable');
  });

  it('uses a custom serviceErrorMessage when provided', () => {
    const { result } = renderHook(() =>
      useSseChannel(testChannel, { onData: () => {}, serviceErrorMessage: 'custom failure' }),
    );
    const es = MockEventSource.instances[0];

    act(() => { es.onopen?.(); });
    act(() => { es.fireEvent('test_channel_error'); });

    expect(result.current.error?.message).toBe('custom failure');
  });

  it('calls onServiceError in addition to setting error state', () => {
    const onServiceError = mock(() => {});
    renderHook(() => useSseChannel(testChannel, { onData: () => {}, onServiceError }));
    const es = MockEventSource.instances[0];

    act(() => { es.onopen?.(); });
    act(() => { es.fireEvent('test_channel_error'); });

    expect(onServiceError).toHaveBeenCalledTimes(1);
  });

  it('clears the service error on the next valid message', () => {
    const { result } = renderHook(() => useSseChannel(testChannel, { onData: () => {} }));
    const es = MockEventSource.instances[0];

    act(() => { es.onopen?.(); });
    act(() => { es.fireEvent('test_channel_error'); });
    expect(result.current.error).not.toBeNull();

    act(() => { es.onmessage?.({ data: JSON.stringify({ value: 1 }) }); });
    expect(result.current.error).toBeNull();
  });

  it('composes the underlying socket error with the service error', () => {
    const setTimeoutSpy = mock((fn: () => void) => { fn(); return 0; });
    const originalSetTimeout = globalThis.setTimeout;
    (globalThis as unknown as { setTimeout: unknown }).setTimeout = setTimeoutSpy;

    try {
      const { result } = renderHook(() => useSseChannel(testChannel, { onData: () => {} }));

      act(() => {
        for (let i = 0; i <= 5; i++) {
          const latest = MockEventSource.instances[MockEventSource.instances.length - 1];
          latest.onerror?.();
        }
      });

      expect(result.current.isConnected).toBe(false);
      expect(result.current.error).not.toBeNull();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('forwards onReconnect to the underlying socket', () => {
    const onReconnect = mock(() => {});
    const setTimeoutSpy = mock((fn: () => void) => { fn(); return 0; });
    const originalSetTimeout = globalThis.setTimeout;
    (globalThis as unknown as { setTimeout: unknown }).setTimeout = setTimeoutSpy;

    try {
      renderHook(() => useSseChannel(testChannel, { onData: () => {}, onReconnect }));

      const es1 = MockEventSource.instances[0];
      act(() => { es1.onopen?.(); });
      act(() => { es1.onerror?.(); });
      const es2 = MockEventSource.instances[MockEventSource.instances.length - 1];
      act(() => { es2.onopen?.(); });

      expect(onReconnect).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});

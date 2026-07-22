import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useContainerLogs } from '../useContainerLogs';
import { _resetLogStreams } from '@/lib/docker/log-stream-registry';
import { MockEventSource } from '@/lib/test/mock-event-source';

const originalEventSource = globalThis.EventSource;

beforeEach(() => {
  MockEventSource.reset();
  _resetLogStreams();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).EventSource = MockEventSource;
});

afterEach(() => {
  _resetLogStreams();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).EventSource = originalEventSource;
});

describe('useContainerLogs', () => {
  const mockTerminal = {
    writeln: mock(() => {}),
    write: mock(() => {}),
    clear: mock(() => {}),
    dispose: mock(() => {}),
  };

  beforeEach(() => {
    mockTerminal.writeln.mockReset();
    mockTerminal.write.mockReset();
    mockTerminal.clear.mockReset();
  });

  it('connects to the correct SSE URL', () => {
    renderHook(() =>
      useContainerLogs({
        containerId: 'abc123',
        host: 'my-server',
        terminal: mockTerminal as unknown as import('@xterm/xterm').Terminal,
      }),
    );

    expect(MockEventSource.instances.length).toBe(1);
    expect(MockEventSource.instances[0].url).toBe('/api/docker-logs/abc123?host=my-server');
  });

  it('encodes special characters in URL', () => {
    renderHook(() =>
      useContainerLogs({
        containerId: 'abc/123',
        host: 'host with spaces',
        terminal: mockTerminal as unknown as import('@xterm/xterm').Terminal,
      }),
    );

    const url = MockEventSource.instances[0].url;
    expect(url).toContain('abc%2F123');
    expect(url).toContain('host%20with%20spaces');
  });

  it('sets isConnected on open', () => {
    const { result } = renderHook(() =>
      useContainerLogs({
        containerId: 'abc123',
        host: 'server',
        terminal: mockTerminal as unknown as import('@xterm/xterm').Terminal,
      }),
    );

    expect(result.current.isConnected).toBe(false);

    act(() => {
      MockEventSource.instances[0].onopen?.();
    });

    expect(result.current.isConnected).toBe(true);
  });

  describe('with queued RAF', () => {
    const origRAF = globalThis.requestAnimationFrame;
    let rafQueue: FrameRequestCallback[] = [];

    beforeEach(() => {
      rafQueue = [];
      globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
        rafQueue.push(cb);
        return rafQueue.length;
      }) as typeof requestAnimationFrame;
    });

    afterEach(() => {
      globalThis.requestAnimationFrame = origRAF;
    });

    const flushRAF = () => {
      const queue = rafQueue;
      rafQueue = [];
      for (const cb of queue) cb(0);
    };

    it('batches multiple lines into a single terminal write per frame', () => {
      renderHook(() =>
        useContainerLogs({
          containerId: 'abc123',
          host: 'server',
          terminal: mockTerminal as unknown as import('@xterm/xterm').Terminal,
        }),
      );

      // Agent emits one line per SSE message; batching across messages within a
      // single frame is the optimization we care about preserving.
      act(() => {
        MockEventSource.instances[0].onopen?.();
        MockEventSource.instances[0].onmessage?.({
          data: JSON.stringify({ text: 'hello world', stream: 'stdout' }),
        });
        MockEventSource.instances[0].onmessage?.({
          data: JSON.stringify({ text: 'error msg', stream: 'stderr' }),
        });
      });

      act(() => { flushRAF(); });

      expect(mockTerminal.write).toHaveBeenCalledTimes(1);
      expect(mockTerminal.write).toHaveBeenCalledWith('hello world\nerror msg\n');
    });
  });

  it('does not connect when enabled=false', () => {
    renderHook(() =>
      useContainerLogs({
        containerId: 'abc123',
        host: 'server',
        terminal: mockTerminal as unknown as import('@xterm/xterm').Terminal,
        enabled: false,
      }),
    );

    expect(MockEventSource.instances.length).toBe(0);
  });

  it('does not connect when terminal is null', () => {
    renderHook(() =>
      useContainerLogs({
        containerId: 'abc123',
        host: 'server',
        terminal: null,
      }),
    );

    expect(MockEventSource.instances.length).toBe(0);
  });

  it('closes EventSource on unmount', () => {
    const { unmount } = renderHook(() =>
      useContainerLogs({
        containerId: 'abc123',
        host: 'server',
        terminal: mockTerminal as unknown as import('@xterm/xterm').Terminal,
      }),
    );

    const es = MockEventSource.instances[0];
    expect(es.closed).toBe(false);

    unmount();

    expect(es.closed).toBe(true);
  });

  describe('with immediate timers', () => {
    const origSetTimeout = globalThis.setTimeout;

    beforeEach(() => {
      (globalThis as unknown as Record<string, unknown>).setTimeout = ((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout;
    });

    afterEach(() => {
      (globalThis as unknown as Record<string, unknown>).setTimeout = origSetTimeout;
    });

    it('sets error after max reconnect attempts with backoff', () => {
      const { result } = renderHook(() =>
        useContainerLogs({
          containerId: 'abc123',
          host: 'server',
          terminal: mockTerminal as unknown as import('@xterm/xterm').Terminal,
        }),
      );

      // 6 iterations = initial connection failure + MAX_RECONNECT_ATTEMPTS (5) retry failures.
      // Each onerror closes the current EventSource and (via the immediate setTimeout mock)
      // immediately opens a new one, so we always call onerror on the latest instance.
      for (let i = 0; i < 6; i++) {
        const es = MockEventSource.instances[MockEventSource.instances.length - 1];
        act(() => { es.onerror?.(); });
      }

      expect(result.current.error).not.toBeNull();
      expect(result.current.error?.message).toContain('multiple reconnect attempts');
      expect(MockEventSource.instances[MockEventSource.instances.length - 1].closed).toBe(true);
    });
  });

  it('does not reconnect after stream_end event from agent', () => {
    const { result } = renderHook(() =>
      useContainerLogs({
        containerId: 'abc123',
        host: 'server',
        terminal: mockTerminal as unknown as import('@xterm/xterm').Terminal,
      }),
    );

    act(() => {
      MockEventSource.instances[0].onopen?.();
      MockEventSource.instances[0].fireEvent('stream_end', {});
      MockEventSource.instances[0].onerror?.();
    });

    // Only the initial connection, no reconnect after stream_end
    expect(MockEventSource.instances.length).toBe(1);
    expect(result.current.isConnected).toBe(false);
    expect(result.current.error).toBeNull();
    // No "Connection lost" message written to terminal after a clean stream_end
    expect(mockTerminal.writeln).not.toHaveBeenCalled();
  });

  describe('error events with immediate RAF', () => {
    const origRAF = globalThis.requestAnimationFrame;

    beforeEach(() => {
      globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 0; }) as typeof requestAnimationFrame;
    });

    afterEach(() => {
      globalThis.requestAnimationFrame = origRAF;
    });

    it('handles error SSE events from the agent', () => {
      renderHook(() =>
        useContainerLogs({
          containerId: 'abc123',
          host: 'server',
          terminal: mockTerminal as unknown as import('@xterm/xterm').Terminal,
        }),
      );

      act(() => {
        MockEventSource.instances[0].onopen?.();
        MockEventSource.instances[0].fireEvent('error', {
          data: JSON.stringify({ message: 'Container not found' }),
        });
      });

      // Agent-emitted error events flow through the per-frame write buffer,
      // not writeln, so the message lands in the terminal alongside log lines.
      expect(mockTerminal.write).toHaveBeenCalledWith(
        expect.stringContaining('Container not found'),
      );
    });
  });
});

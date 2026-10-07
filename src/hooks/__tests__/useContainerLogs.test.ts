import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useContainerLogs } from '../useContainerLogs';
import { _resetLogStreams } from '@/lib/docker/log-stream-registry';
import { MockEventSource } from '@/lib/test/mock-event-source';

const originalEventSource = globalThis.EventSource;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  MockEventSource.reset();
  _resetLogStreams();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).EventSource = MockEventSource;
  globalThis.fetch = mock(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
});

afterEach(() => {
  _resetLogStreams();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).EventSource = originalEventSource;
  globalThis.fetch = originalFetch;
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

  it('connects to the mux endpoint with a session id', () => {
    renderHook(() =>
      useContainerLogs({
        containerId: 'abc123',
        host: 'my-server',
        terminal: mockTerminal as unknown as import('@xterm/xterm').Terminal,
      }),
    );

    expect(MockEventSource.instances.length).toBe(1);
    expect(MockEventSource.instances[0].url).toMatch(/^\/api\/docker-logs-mux\?session=[A-Za-z0-9-]+$/);
  });

  it('sends the raw host/container key in the subscribe command', () => {
    renderHook(() =>
      useContainerLogs({
        containerId: 'abc/123',
        host: 'host with spaces',
        terminal: mockTerminal as unknown as import('@xterm/xterm').Terminal,
      }),
    );

    act(() => {
      MockEventSource.instances[0].onopen?.();
    });

    const call = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    const body = (call[1] as RequestInit).body as string;
    expect(body).toContain('host with spaces/abc/123');
  });

  it('sets isConnected when the key backlog starts', () => {
    const { result } = renderHook(() =>
      useContainerLogs({
        containerId: 'abc123',
        host: 'server',
        terminal: mockTerminal as unknown as import('@xterm/xterm').Terminal,
      }),
    );

    expect(result.current.isConnected).toBe(false);

    act(() => {
      MockEventSource.instances[0].fireEvent('backlog_start', { data: JSON.stringify({ key: 'server/abc123' }) });
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

      // Batching across messages within a single frame is the optimization under test.
      act(() => {
        MockEventSource.instances[0].onopen?.();
        MockEventSource.instances[0].onmessage?.({
          data: JSON.stringify({ key: 'server/abc123', line: { text: 'hello world', stream: 'stdout' } }),
        });
        MockEventSource.instances[0].onmessage?.({
          data: JSON.stringify({ key: 'server/abc123', line: { text: 'error msg', stream: 'stderr' } }),
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

      // 6 iterations = initial failure + MAX_RECONNECT_ATTEMPTS (5) retries; always call onerror on the latest instance.
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
      MockEventSource.instances[0].fireEvent('stream_end', { data: JSON.stringify({ key: 'server/abc123' }) });
      MockEventSource.instances[0].onerror?.();
    });

    // The stream reported a clean end. The shared mux reconnects on its own
    // schedule (real timer here), so no second instance exists yet.
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
          data: JSON.stringify({ key: 'server/abc123', message: 'Container not found' }),
        });
      });

      // Flows through the per-frame write buffer, not writeln.
      expect(mockTerminal.write).toHaveBeenCalledWith(
        expect.stringContaining('Container not found'),
      );
    });
  });
});

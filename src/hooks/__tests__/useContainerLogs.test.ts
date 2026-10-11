import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { mockModule } from '@/lib/test/mock-module';
import { FakeMuxConnection } from '@/lib/test/fake-mux';

const fakeMux = new FakeMuxConnection();
mockModule<typeof import('@/lib/mux/mux-connection')>('@/lib/mux/mux-connection', (real) => ({
  ...real,
  muxConnection: fakeMux,
}));

import { useContainerLogs } from '../useContainerLogs';
import { _resetLogStreams } from '@/lib/docker/log-stream-registry';

beforeEach(() => {
  _resetLogStreams();
  fakeMux.subscriptions.clear();
  fakeMux.status = { connected: false, error: null };
});

afterEach(() => {
  _resetLogStreams();
});

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

function mountLogs(overrides: Record<string, unknown> = {}) {
  return renderHook(() =>
    useContainerLogs({
      containerId: 'abc123',
      host: 'server',
      terminal: mockTerminal as unknown as import('@xterm/xterm').Terminal,
      ...overrides,
    }),
  );
}

describe('useContainerLogs', () => {
  it('subscribes to the container logs mux topic on mount', () => {
    mountLogs();
    expect(fakeMux.subscribedTopics()).toEqual(['logs:server/abc123']);
  });

  it('sets isConnected on mux connect', () => {
    const { result } = mountLogs();
    expect(result.current.isConnected).toBe(false);

    act(() => { fakeMux.setStatus({ connected: true, error: null }); });
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
      mountLogs();

      // Batching across messages within a single frame is the optimization under test.
      act(() => {
        fakeMux.setStatus({ connected: true, error: null });
        fakeMux.emit('logs:server/abc123', 'data', { text: 'hello world', stream: 'stdout' });
        fakeMux.emit('logs:server/abc123', 'data', { text: 'error msg', stream: 'stderr' });
      });

      act(() => { flushRAF(); });

      expect(mockTerminal.write).toHaveBeenCalledTimes(1);
      expect(mockTerminal.write).toHaveBeenCalledWith('hello world\nerror msg\n');
    });
  });

  it('does not subscribe when enabled=false', () => {
    mountLogs({ enabled: false });
    expect(fakeMux.subscribedTopics()).toEqual([]);
  });

  it('does not subscribe when terminal is null', () => {
    mountLogs({ terminal: null });
    expect(fakeMux.subscribedTopics()).toEqual([]);
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = mountLogs();
    expect(fakeMux.subscriptionCount('logs:server/abc123')).toBe(1);
    unmount();
    expect(fakeMux.subscriptionCount('logs:server/abc123')).toBe(0);
  });

  it('reports a clean disconnect on stream_end without a Connection lost line', () => {
    const { result } = mountLogs();
    act(() => {
      fakeMux.setStatus({ connected: true, error: null });
      fakeMux.emit('logs:server/abc123', 'stream_end', {});
    });

    expect(result.current.isConnected).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mockTerminal.writeln).not.toHaveBeenCalled();
  });

  it('writes a Connection lost line on unclean connection loss', () => {
    const origSetTimeout = globalThis.setTimeout;
    (globalThis as unknown as Record<string, unknown>).setTimeout = ((_fn: () => void) => 0) as unknown as typeof setTimeout;
    try {
      mountLogs();
      act(() => {
        fakeMux.setStatus({ connected: true, error: null });
        fakeMux.setStatus({ connected: false, error: null });
      });

      expect(mockTerminal.writeln).toHaveBeenCalledWith('\x1b[31m[Error] Connection lost\x1b[0m');
    } finally {
      (globalThis as unknown as Record<string, unknown>).setTimeout = origSetTimeout;
    }
  });

  describe('error frames with immediate RAF', () => {
    const origRAF = globalThis.requestAnimationFrame;
    beforeEach(() => {
      globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 0; }) as typeof requestAnimationFrame;
    });
    afterEach(() => {
      globalThis.requestAnimationFrame = origRAF;
    });

    it('handles agent error frames as terminal output', () => {
      mountLogs();

      act(() => {
        fakeMux.setStatus({ connected: true, error: null });
        fakeMux.emit('logs:server/abc123', 'error', { message: 'Container not found', gone: false });
      });

      // Flows through the per-frame write buffer, not writeln.
      expect(mockTerminal.write).toHaveBeenCalledWith(
        expect.stringContaining('Container not found'),
      );
    });

    it('surfaces gone error frames as hook errors', () => {
      const { result } = mountLogs();

      act(() => {
        fakeMux.setStatus({ connected: true, error: null });
        fakeMux.emit('logs:server/abc123', 'error', {
          message: 'Log stream disconnected after multiple reconnect attempts.',
          gone: true,
        });
      });

      expect(result.current.error?.message).toContain('multiple reconnect attempts');
    });
  });

  it('surfaces a subscribe rejection as the hook error state', () => {
    const { result } = mountLogs();

    act(() => {
      fakeMux.emitSubscribeRejected('logs:server/abc123', {
        code: 'topic_limit',
        message: 'Session topic limit (250) reached. Unsubscribe unused topics.',
      });
    });

    expect(result.current.error?.message).toContain('Session topic limit');
  });
});

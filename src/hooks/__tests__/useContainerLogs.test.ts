import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useContainerLogs } from '../useContainerLogs';

// Mock EventSource
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((event: unknown) => void)[]>();
  readyState = 0; // CONNECTING
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (event: unknown) => void) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type: string, handler: (event: unknown) => void) {
    const handlers = this.listeners.get(type) ?? [];
    this.listeners.set(type, handlers.filter(h => h !== handler));
  }

  dispatchEvent(type: string, data: unknown) {
    const handlers = this.listeners.get(type) ?? [];
    for (const handler of handlers) {
      handler(data);
    }
  }

  close() {
    this.closed = true;
    this.readyState = 2; // CLOSED
  }

  static reset() {
    MockEventSource.instances = [];
  }
}

const originalEventSource = globalThis.EventSource;

beforeEach(() => {
  MockEventSource.reset();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).EventSource = MockEventSource;
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).EventSource = originalEventSource;
});

describe('useContainerLogs', () => {
  const mockTerminal = {
    writeln: mock(() => {}),
    write: mock(() => {}),
    dispose: mock(() => {}),
  };

  beforeEach(() => {
    mockTerminal.writeln.mockReset();
    mockTerminal.write.mockReset();
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

  it('writes log lines to terminal on message', () => {
    // The hook batches writes via requestAnimationFrame — run callbacks synchronously
    const origRAF = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 0; }) as typeof requestAnimationFrame;

    try {
      renderHook(() =>
        useContainerLogs({
          containerId: 'abc123',
          host: 'server',
          terminal: mockTerminal as unknown as import('@xterm/xterm').Terminal,
        }),
      );

      act(() => {
        MockEventSource.instances[0].onopen?.();
        MockEventSource.instances[0].onmessage?.({
          data: JSON.stringify({
            lines: [
              { text: 'hello world', stream: 'stdout' },
              { text: 'error msg', stream: 'stderr' },
            ],
          }),
        });
      });

      expect(mockTerminal.write).toHaveBeenCalledTimes(1);
      expect(mockTerminal.write).toHaveBeenCalledWith('hello world\nerror msg\n');
    } finally {
      globalThis.requestAnimationFrame = origRAF;
    }
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

      // Each error closes and reconnects (setTimeout fires immediately)
      for (let i = 0; i < 5; i++) {
        const es = MockEventSource.instances[MockEventSource.instances.length - 1];
        act(() => { es.onerror?.(); });
      }

      expect(result.current.error).not.toBeNull();
      expect(result.current.error?.message).toContain('failed after multiple attempts');
      expect(MockEventSource.instances[MockEventSource.instances.length - 1].closed).toBe(true);
    });
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
      MockEventSource.instances[0].dispatchEvent('error', {
        data: JSON.stringify({ message: 'Container not found' }),
      });
    });

    expect(mockTerminal.writeln).toHaveBeenCalledWith(
      expect.stringContaining('Container not found'),
    );
  });
});

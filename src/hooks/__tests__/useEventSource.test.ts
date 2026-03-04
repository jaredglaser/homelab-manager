import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useEventSource } from '../useEventSource';

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((event: unknown) => void)[]>();
  readyState = 0;
  closed = false;

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

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

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  static reset() {
    MockEventSource.instances = [];
  }
}

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
    const { result } = renderHook(() =>
      useEventSource({ url: '/api/test', onData: () => {} })
    );

    const es = MockEventSource.instances[0];

    // Exhaust reconnect attempts (5 errors)
    act(() => { for (let i = 0; i < 5; i++) es.onerror?.(); });

    expect(es.closed).toBe(true);
    expect(result.current.error).not.toBeNull();
    expect(MockEventSource.instances).toHaveLength(1);

    // Tab becomes visible — should create a new connection
    act(() => simulateVisibilityChange('visible'));

    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1].closed).toBe(false);
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
    const { result } = renderHook(() =>
      useEventSource({ url: '/api/test', onData: () => {} })
    );

    const es = MockEventSource.instances[0];
    act(() => { for (let i = 0; i < 5; i++) es.onerror?.(); });
    expect(result.current.error).not.toBeNull();

    act(() => simulateVisibilityChange('visible'));

    const newEs = MockEventSource.instances[1];
    act(() => { newEs.onopen?.(); });

    expect(result.current.error).toBeNull();
    expect(result.current.isConnected).toBe(true);
  });
});

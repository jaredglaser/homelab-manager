import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { subscribeToContainerLogs, _resetLogStreams, type LogStreamSubscriber } from '@/lib/docker/log-stream-registry';

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((event: unknown) => void)[]>();
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
    this.listeners.set(type, handlers.filter((h) => h !== handler));
  }

  dispatchEvent(type: string, data: unknown) {
    const handlers = this.listeners.get(type) ?? [];
    for (const handler of handlers) handler(data);
  }

  close() {
    this.closed = true;
  }

  static reset() {
    MockEventSource.instances = [];
  }
}

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

function makeSubscriber(): LogStreamSubscriber & {
  lines: { text: string; stream: string }[];
  connects: number;
  disconnects: number;
  errors: Error[];
  clears: number;
} {
  const lines: { text: string; stream: string }[] = [];
  let connects = 0;
  let disconnects = 0;
  const errors: Error[] = [];
  let clears = 0;
  return {
    lines,
    get connects() { return connects; },
    get disconnects() { return disconnects; },
    errors,
    get clears() { return clears; },
    onLine: (line) => { lines.push(line); },
    onConnect: () => { connects++; },
    onDisconnect: () => { disconnects++; },
    onError: (err) => { errors.push(err); },
    onClear: () => { clears++; },
  };
}

describe('log-stream-registry', () => {
  it('opens an EventSource for the first subscriber', () => {
    const sub = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub });

    expect(MockEventSource.instances.length).toBe(1);
    expect(MockEventSource.instances[0].url).toBe('/api/docker-logs/abc?host=server');
  });

  it('reuses the EventSource for a second subscriber to the same container', () => {
    const sub1 = makeSubscriber();
    const sub2 = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub1 });
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub2 });

    expect(MockEventSource.instances.length).toBe(1);
  });

  it('opens separate EventSources for different containers', () => {
    const sub1 = makeSubscriber();
    const sub2 = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub1 });
    subscribeToContainerLogs({ host: 'server', containerId: 'def', subscriber: sub2 });

    expect(MockEventSource.instances.length).toBe(2);
  });

  it('broadcasts new lines to all current subscribers', () => {
    const sub1 = makeSubscriber();
    const sub2 = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub1 });
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub2 });

    MockEventSource.instances[0].onmessage?.({
      data: JSON.stringify({ lines: [{ text: 'hello', stream: 'stdout' }] }),
    });

    expect(sub1.lines).toEqual([{ text: 'hello', stream: 'stdout' }]);
    expect(sub2.lines).toEqual([{ text: 'hello', stream: 'stdout' }]);
  });

  it('replays the buffered backlog to a late-joining subscriber', () => {
    const sub1 = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub1 });

    MockEventSource.instances[0].onmessage?.({
      data: JSON.stringify({ lines: [{ text: 'one', stream: 'stdout' }, { text: 'two', stream: 'stdout' }] }),
    });

    const sub2 = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub2 });

    expect(sub2.lines).toEqual([
      { text: 'one', stream: 'stdout' },
      { text: 'two', stream: 'stdout' },
    ]);
  });

  it('replays connected state to a late joiner', () => {
    const sub1 = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub1 });
    MockEventSource.instances[0].onopen?.();

    const sub2 = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub2 });

    expect(sub2.connects).toBe(1);
  });

  it('keeps the stream alive while at least one subscriber remains', () => {
    const sub1 = makeSubscriber();
    const sub2 = makeSubscriber();
    const unsub1 = subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub1 });
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub2 });

    unsub1();

    expect(MockEventSource.instances[0].closed).toBe(false);
  });

  it('closes the stream when the last subscriber unsubscribes', () => {
    const sub1 = makeSubscriber();
    const unsub1 = subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub1 });

    unsub1();

    expect(MockEventSource.instances[0].closed).toBe(true);
  });

  it('does not deliver lines to a subscriber after it unsubscribes', () => {
    const sub1 = makeSubscriber();
    const sub2 = makeSubscriber();
    const unsub1 = subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub1 });
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub2 });

    unsub1();
    MockEventSource.instances[0].onmessage?.({
      data: JSON.stringify({ lines: [{ text: 'late', stream: 'stdout' }] }),
    });

    expect(sub1.lines).toHaveLength(0);
    expect(sub2.lines).toEqual([{ text: 'late', stream: 'stdout' }]);
  });

  describe('reconnect with immediate timers', () => {
    const origSetTimeout = globalThis.setTimeout;

    beforeEach(() => {
      (globalThis as unknown as Record<string, unknown>).setTimeout = ((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout;
    });

    afterEach(() => {
      (globalThis as unknown as Record<string, unknown>).setTimeout = origSetTimeout;
    });

    it('clears the buffer and notifies subscribers when reconnecting', () => {
      const sub = makeSubscriber();
      subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub });

      MockEventSource.instances[0].onopen?.();
      MockEventSource.instances[0].onmessage?.({
        data: JSON.stringify({ lines: [{ text: 'old-line', stream: 'stdout' }] }),
      });

      MockEventSource.instances[0].onerror?.();
      MockEventSource.instances[MockEventSource.instances.length - 1].onopen?.();

      expect(sub.clears).toBe(1);

      // After reconnect, a fresh subscriber should NOT see the old buffered line.
      const sub2 = makeSubscriber();
      subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub2 });
      expect(sub2.lines).toHaveLength(0);
    });

    it('reports error after max reconnect attempts', () => {
      const sub = makeSubscriber();
      subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub });

      // Initial failure + 5 retry failures = 6 onerror calls
      for (let i = 0; i < 6; i++) {
        const es = MockEventSource.instances[MockEventSource.instances.length - 1];
        es.onerror?.();
      }

      expect(sub.errors.length).toBe(1);
      expect(sub.errors[0].message).toContain('multiple reconnect attempts');
    });

    it('does not reconnect after stream_end', () => {
      const sub = makeSubscriber();
      subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub });

      MockEventSource.instances[0].onopen?.();
      MockEventSource.instances[0].dispatchEvent('stream_end', {});
      MockEventSource.instances[0].onerror?.();

      expect(MockEventSource.instances.length).toBe(1);
      expect(sub.errors.length).toBe(0);
    });
  });

  it('reports agent-emitted error events as a log line', () => {
    const sub = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub });

    MockEventSource.instances[0].dispatchEvent('error', {
      data: JSON.stringify({ message: 'Container not found' }),
    });

    expect(sub.lines.length).toBe(1);
    expect(sub.lines[0].text).toContain('Container not found');
    expect(sub.lines[0].stream).toBe('stderr');
  });

  it('calls onDisconnect on transient connection loss', () => {
    const origSetTimeout = globalThis.setTimeout;
    (globalThis as unknown as Record<string, unknown>).setTimeout = ((_fn: () => void) => 0) as unknown as typeof setTimeout;
    try {
      const sub = makeSubscriber();
      subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub });

      MockEventSource.instances[0].onopen?.();
      MockEventSource.instances[0].onerror?.();

      expect(sub.disconnects).toBe(1);
    } finally {
      (globalThis as unknown as Record<string, unknown>).setTimeout = origSetTimeout;
    }
  });

  it('opens a fresh stream after the previous one is fully unsubscribed', () => {
    const sub1 = makeSubscriber();
    const unsub1 = subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub1 });
    unsub1();

    const sub2 = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub2 });

    expect(MockEventSource.instances.length).toBe(2);
  });

});

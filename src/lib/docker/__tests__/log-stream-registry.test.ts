import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { subscribeToContainerLogs, _resetLogStreams, type LogStreamSubscriber } from '@/lib/docker/log-stream-registry';
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

function makeSubscriber(): LogStreamSubscriber & {
  lines: { text: string; stream: string }[];
  connects: number;
  disconnects: number;
  cleanDisconnects: number;
  errors: Error[];
  clears: number;
} {
  const lines: { text: string; stream: string }[] = [];
  let connects = 0;
  let disconnects = 0;
  let cleanDisconnects = 0;
  const errors: Error[] = [];
  let clears = 0;
  return {
    lines,
    get connects() { return connects; },
    get disconnects() { return disconnects; },
    get cleanDisconnects() { return cleanDisconnects; },
    errors,
    get clears() { return clears; },
    onLine: (line) => { lines.push(line); },
    onConnect: () => { connects++; },
    onDisconnect: (cleanEnd) => { disconnects++; if (cleanEnd) cleanDisconnects++; },
    onError: (err) => { errors.push(err); },
    onClear: () => { clears++; },
  };
}

function lastEventSource(): MockEventSource {
  return MockEventSource.instances[MockEventSource.instances.length - 1];
}

function postedCommands(): { session: string; subscribe: string[]; unsubscribe: string[] }[] {
  return (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
    ([, init]) => JSON.parse((init as RequestInit).body as string) as { session: string; subscribe: string[]; unsubscribe: string[] },
  );
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('log-stream-registry', () => {
  it('opens one mux EventSource carrying a session id', () => {
    const sub = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub });

    expect(MockEventSource.instances.length).toBe(1);
    expect(MockEventSource.instances[0].url).toMatch(/^\/api\/docker-logs-mux\?session=[A-Za-z0-9-]+$/);
  });

  it('never reopens the EventSource when other containers subscribe and unsubscribe', () => {
    // Regression: the previous transport rebuilt the connection per key-set
    // change, which flashed every open log viewer on each expand/collapse.
    const subAbc = makeSubscriber();
    const subDef = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: subAbc });
    subscribeToContainerLogs({ host: 'server', containerId: 'def', subscriber: subDef });

    const subGhi = makeSubscriber();
    const unsubGhi = subscribeToContainerLogs({ host: 'server', containerId: 'ghi', subscriber: subGhi });
    unsubGhi();

    expect(MockEventSource.instances.length).toBe(1);
    expect(MockEventSource.instances[0].closed).toBe(false);
  });

  it('resyncs the full key set when the connection opens', async () => {
    const subAbc = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: subAbc });
    subscribeToContainerLogs({ host: 'server', containerId: 'def', subscriber: makeSubscriber() });

    lastEventSource().onopen?.();
    await flushMicrotasks();

    const commands = postedCommands();
    expect(commands).toHaveLength(1);
    expect(commands[0].subscribe.sort()).toEqual(['server/abc', 'server/def']);
    expect(commands[0].unsubscribe).toEqual([]);
  });

  it('sends a subscribe command for a container added after open', async () => {
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: makeSubscriber() });
    lastEventSource().onopen?.();
    await flushMicrotasks();

    subscribeToContainerLogs({ host: 'server', containerId: 'def', subscriber: makeSubscriber() });
    await flushMicrotasks();

    const commands = postedCommands();
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual({ session: commands[0].session, subscribe: ['server/def'], unsubscribe: [] });
  });

  it('sends an unsubscribe command when a container drops while others remain', async () => {
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: makeSubscriber() });
    const unsubDef = subscribeToContainerLogs({ host: 'server', containerId: 'def', subscriber: makeSubscriber() });
    lastEventSource().onopen?.();
    await flushMicrotasks();

    unsubDef();
    await flushMicrotasks();

    const commands = postedCommands();
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual({ session: commands[0].session, subscribe: [], unsubscribe: ['server/def'] });
  });

  it('does not command the server before the connection has opened', async () => {
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: makeSubscriber() });
    await flushMicrotasks();

    // No session exists server-side yet; the open resync covers it.
    expect(postedCommands()).toHaveLength(0);
  });

  it('routes frames to the matching container only', () => {
    const subAbc = makeSubscriber();
    const subDef = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: subAbc });
    subscribeToContainerLogs({ host: 'server', containerId: 'def', subscriber: subDef });

    lastEventSource().onmessage?.({
      data: JSON.stringify({ key: 'server/def', line: { text: 'from-def', stream: 'stdout' } }),
    });

    expect(subAbc.lines).toHaveLength(0);
    expect(subDef.lines).toEqual([{ text: 'from-def', stream: 'stdout' }]);
  });

  it('accepts batched line frames', () => {
    const sub = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub });

    lastEventSource().onmessage?.({
      data: JSON.stringify({ key: 'server/abc', lines: [{ text: 'one', stream: 'stdout' }, { text: 'two', stream: 'stdout' }] }),
    });

    expect(sub.lines).toEqual([
      { text: 'one', stream: 'stdout' },
      { text: 'two', stream: 'stdout' },
    ]);
  });

  it('marks a stream connected on backlog_start and replays to late joiners', () => {
    const sub1 = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub1 });

    lastEventSource().fireEvent('backlog_start', { data: JSON.stringify({ key: 'server/abc' }) });
    lastEventSource().onmessage?.({
      data: JSON.stringify({ key: 'server/abc', line: { text: 'one', stream: 'stdout' } }),
    });

    const sub2 = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub2 });

    expect(sub1.connects).toBe(1);
    expect(sub2.connects).toBe(1);
    expect(sub2.lines).toEqual([{ text: 'one', stream: 'stdout' }]);
  });

  it('keeps the mux alive while at least one subscriber remains', () => {
    const sub1 = makeSubscriber();
    const sub2 = makeSubscriber();
    const unsub1 = subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub1 });
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub2 });

    unsub1();

    expect(lastEventSource().closed).toBe(false);
  });

  it('closes the mux when the last subscriber unsubscribes', () => {
    const sub1 = makeSubscriber();
    const unsub1 = subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub1 });

    unsub1();

    expect(lastEventSource().closed).toBe(true);
  });

  it('does not deliver lines to a subscriber after it unsubscribes', () => {
    const sub1 = makeSubscriber();
    const sub2 = makeSubscriber();
    const unsub1 = subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub1 });
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub2 });

    unsub1();
    lastEventSource().onmessage?.({
      data: JSON.stringify({ key: 'server/abc', line: { text: 'late', stream: 'stdout' } }),
    });

    expect(sub1.lines).toHaveLength(0);
    expect(sub2.lines).toEqual([{ text: 'late', stream: 'stdout' }]);
  });

  it('clears the buffer when a fresh backlog arrives for a key', () => {
    const sub = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub });

    lastEventSource().fireEvent('backlog_start', { data: JSON.stringify({ key: 'server/abc' }) });
    lastEventSource().onmessage?.({
      data: JSON.stringify({ key: 'server/abc', line: { text: 'old-line', stream: 'stdout' } }),
    });
    lastEventSource().fireEvent('backlog_start', { data: JSON.stringify({ key: 'server/abc' }) });

    expect(sub.clears).toBe(1);
    expect(sub.lines).toHaveLength(1);
  });

  it('rejects subscriptions beyond the stream cap with an error', () => {
    for (let i = 0; i < 20; i++) {
      subscribeToContainerLogs({ host: 'server', containerId: `c${i}`, subscriber: makeSubscriber() });
    }

    const overflow = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'one-too-many', subscriber: overflow });

    expect(overflow.errors).toHaveLength(1);
    expect(overflow.errors[0].message).toContain('Too many rows');
    expect(MockEventSource.instances.length).toBe(1);
  });

  describe('reconnect with immediate timers', () => {
    const origSetTimeout = globalThis.setTimeout;

    beforeEach(() => {
      (globalThis as unknown as Record<string, unknown>).setTimeout = ((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout;
    });

    afterEach(() => {
      (globalThis as unknown as Record<string, unknown>).setTimeout = origSetTimeout;
    });

    it('clears the buffer and notifies subscribers when a reconnect replays the backlog', () => {
      const sub = makeSubscriber();
      subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub });

      lastEventSource().onopen?.();
      lastEventSource().fireEvent('backlog_start', { data: JSON.stringify({ key: 'server/abc' }) });
      lastEventSource().onmessage?.({
        data: JSON.stringify({ key: 'server/abc', line: { text: 'old-line', stream: 'stdout' } }),
      });

      lastEventSource().onerror?.();
      lastEventSource().onopen?.();
      lastEventSource().fireEvent('backlog_start', { data: JSON.stringify({ key: 'server/abc' }) });

      expect(sub.clears).toBe(1);
      expect(sub.lines).toHaveLength(1);
    });

    it('reports error after max reconnect attempts', () => {
      const sub = makeSubscriber();
      subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub });

      // Initial failure + 5 retry failures = 6 onerror calls
      for (let i = 0; i < 6; i++) {
        lastEventSource().onerror?.();
      }

      expect(sub.errors.length).toBe(1);
      expect(sub.errors[0].message).toContain('multiple reconnect attempts');
    });

    it('marks a stream_end as a clean disconnect but keeps the mux reconnecting', () => {
      const sub = makeSubscriber();
      subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub });

      lastEventSource().onopen?.();
      lastEventSource().fireEvent('backlog_start', { data: JSON.stringify({ key: 'server/abc' }) });
      lastEventSource().fireEvent('stream_end', { data: JSON.stringify({ key: 'server/abc' }) });
      lastEventSource().onerror?.();

      // The shared connection must survive one container's clean end.
      expect(sub.disconnects).toBe(1);
      expect(sub.cleanDisconnects).toBe(1);
      expect(sub.errors.length).toBe(0);
      expect(MockEventSource.instances.length).toBe(2);
    });
  });

  it('reports agent-emitted error events as a log line', () => {
    const sub = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub });

    lastEventSource().fireEvent('error', {
      data: JSON.stringify({ key: 'server/abc', message: 'Container not found' }),
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

      lastEventSource().onopen?.();
      lastEventSource().fireEvent('backlog_start', { data: JSON.stringify({ key: 'server/abc' }) });
      lastEventSource().onerror?.();

      expect(sub.disconnects).toBe(1);
    } finally {
      (globalThis as unknown as Record<string, unknown>).setTimeout = origSetTimeout;
    }
  });

  it('opens a fresh mux after everything is unsubscribed', () => {
    const sub1 = makeSubscriber();
    const unsub1 = subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub1 });
    unsub1();

    const sub2 = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub2 });

    expect(MockEventSource.instances.length).toBe(2);
    expect(MockEventSource.instances[0].closed).toBe(true);
  });
});

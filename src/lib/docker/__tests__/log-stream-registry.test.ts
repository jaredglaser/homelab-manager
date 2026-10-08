import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { FakeMuxConnection } from '@/lib/test/fake-mux';

const fakeMux = new FakeMuxConnection();
mock.module('@/lib/mux/mux-connection', () => ({ muxConnection: fakeMux }));

import { subscribeToContainerLogs, _resetLogStreams, type LogStreamSubscriber } from '@/lib/docker/log-stream-registry';

beforeEach(() => {
  _resetLogStreams();
  fakeMux.subscriptions.clear();
  fakeMux.status = { connected: false, error: null };
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
  it('subscribes one mux topic per host/container shared across subscribers', () => {
    const sub1 = makeSubscriber();
    const sub2 = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub1 });
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub2 });

    expect(fakeMux.subscribedTopics()).toEqual(['logs:server/abc']);
    expect(fakeMux.subscriptionCount('logs:server/abc')).toBe(1);
  });

  it('subscribes separate topics for different containers', () => {
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: makeSubscriber() });
    subscribeToContainerLogs({ host: 'server', containerId: 'def', subscriber: makeSubscriber() });

    expect(fakeMux.subscribedTopics().sort()).toEqual(['logs:server/abc', 'logs:server/def']);
  });

  it('broadcasts new lines to all current subscribers', () => {
    const sub1 = makeSubscriber();
    const sub2 = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub1 });
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub2 });

    fakeMux.emit('logs:server/abc', 'data', { lines: [{ text: 'hello', stream: 'stdout' }] });

    expect(sub1.lines).toEqual([{ text: 'hello', stream: 'stdout' }]);
    expect(sub2.lines).toEqual([{ text: 'hello', stream: 'stdout' }]);
  });

  it('accepts single-line data payloads', () => {
    const sub = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub });

    fakeMux.emit('logs:server/abc', 'data', { text: 'solo', stream: 'stderr' });

    expect(sub.lines).toEqual([{ text: 'solo', stream: 'stderr' }]);
  });

  it('replays the buffered backlog to a late-joining subscriber', () => {
    const sub1 = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub1 });

    fakeMux.emit('logs:server/abc', 'data', { lines: [{ text: 'one', stream: 'stdout' }, { text: 'two', stream: 'stdout' }] });

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
    fakeMux.setStatus({ connected: true, error: null });

    const sub2 = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub2 });

    expect(sub2.connects).toBe(1);
  });

  it('keeps the topic subscribed while at least one subscriber remains and drops it with the last', () => {
    const unsub1 = subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: makeSubscriber() });
    const unsub2 = subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: makeSubscriber() });

    unsub1();
    expect(fakeMux.subscriptionCount('logs:server/abc')).toBe(1);

    unsub2();
    expect(fakeMux.subscribedTopics()).toEqual([]);
  });

  it('does not deliver lines to a subscriber after it unsubscribes', () => {
    const sub1 = makeSubscriber();
    const sub2 = makeSubscriber();
    const unsub1 = subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub1 });
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub2 });

    unsub1();
    fakeMux.emit('logs:server/abc', 'data', { lines: [{ text: 'late', stream: 'stdout' }] });

    expect(sub1.lines).toHaveLength(0);
    expect(sub2.lines).toEqual([{ text: 'late', stream: 'stdout' }]);
  });

  it('clears the buffer and notifies subscribers on backlog_start', () => {
    const sub = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub });

    fakeMux.emit('logs:server/abc', 'data', { lines: [{ text: 'old-line', stream: 'stdout' }] });
    fakeMux.emit('logs:server/abc', 'backlog_start', {});

    expect(sub.clears).toBe(1);
    const sub2 = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub2 });
    expect(sub2.lines).toHaveLength(0);
  });

  it('reports a gone error frame as a log line and an onError', () => {
    const sub = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub });

    fakeMux.emit('logs:server/abc', 'error', {
      message: 'Log stream disconnected after multiple reconnect attempts.',
      gone: true,
    });

    expect(sub.errors.length).toBe(1);
    expect(sub.errors[0].message).toContain('multiple reconnect attempts');
    expect(sub.lines.length).toBe(1);
    expect(sub.lines[0].stream).toBe('stderr');
  });

  it('reports agent-emitted error frames as a log line without onError', () => {
    const sub = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub });

    fakeMux.emit('logs:server/abc', 'error', { message: 'Container not found', gone: false });

    expect(sub.lines.length).toBe(1);
    expect(sub.lines[0].text).toContain('Container not found');
    expect(sub.lines[0].stream).toBe('stderr');
    expect(sub.errors.length).toBe(0);
  });

  it('reports a clean disconnect on stream_end', () => {
    const sub = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub });
    fakeMux.setStatus({ connected: true, error: null });

    fakeMux.emit('logs:server/abc', 'stream_end', {});

    expect(sub.disconnects).toBe(1);
    expect(sub.errors.length).toBe(0);
  });

  it('reports an unclean disconnect on connection loss', () => {
    const sub = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub });
    fakeMux.setStatus({ connected: true, error: null });
    fakeMux.setStatus({ connected: false, error: null });

    expect(sub.disconnects).toBe(1);
  });

  it('opens a fresh topic after the previous one is fully unsubscribed', () => {
    const unsub1 = subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: makeSubscriber() });
    unsub1();

    const sub2 = makeSubscriber();
    subscribeToContainerLogs({ host: 'server', containerId: 'abc', subscriber: sub2 });
    fakeMux.emit('logs:server/abc', 'data', { lines: [{ text: 'fresh', stream: 'stdout' }] });

    expect(sub2.lines).toEqual([{ text: 'fresh', stream: 'stdout' }]);
  });
});

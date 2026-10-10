import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { MuxConnection, type MuxStatus, type MuxTopicHandlers } from '@/lib/mux/mux-connection';
import type { MuxTopicFrame } from '@/lib/mux/protocol';

class FakeSocket {
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = 3;
  }

  fireOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  fireMessage(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  fireClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

let sockets: FakeSocket[];
let connection: MuxConnection;

function makeHandlers(): MuxTopicHandlers & { events: MuxTopicFrame[]; statuses: MuxStatus[] } {
  const events: MuxTopicFrame[] = [];
  const statuses: MuxStatus[] = [];
  return {
    events,
    statuses,
    onEvent: (frame) => { events.push(frame); },
    onStatus: (status) => { statuses.push(status); },
  };
}

beforeEach(() => {
  sockets = [];
  connection = new MuxConnection('/api/mux', {
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
});

afterEach(() => {
  connection._reset();
});

describe('MuxConnection', () => {
  it('opens one connection on first subscribe and sends the topic on open', () => {
    connection.subscribe('inventory', makeHandlers());
    expect(sockets).toHaveLength(1);

    sockets[0].fireOpen();

    expect(sockets[0].sent).toEqual([{ type: 'sub', ref: 0, topics: ['inventory'] }]);
  });

  it('ref-counts topics on the wire', () => {
    const unsubA = connection.subscribe('inventory', makeHandlers());
    connection.subscribe('inventory', makeHandlers());
    sockets[0].fireOpen();

    expect(sockets[0].sent).toEqual([{ type: 'sub', ref: 0, topics: ['inventory'] }]);

    connection.subscribe('logs:s/abc', makeHandlers());
    expect(sockets[0].sent).toEqual([
      { type: 'sub', ref: 0, topics: ['inventory'] },
      { type: 'sub', ref: 1, topics: ['logs:s/abc'] },
    ]);

    unsubA();
    expect(sockets[0].sent).toHaveLength(2);

    const unsubB = connection.subscribe('inventory', makeHandlers());
    unsubB();
    expect(sockets[0].sent).toEqual([
      { type: 'sub', ref: 0, topics: ['inventory'] },
      { type: 'sub', ref: 1, topics: ['logs:s/abc'] },
    ]);
  });

  it('closes the socket when the last topic unsubscribes', () => {
    const unsub = connection.subscribe('inventory', makeHandlers());
    sockets[0].fireOpen();

    unsub();

    expect(sockets[0].sent).toContainEqual({ type: 'unsub', ref: 1, topics: ['inventory'] });
    expect(sockets[0].readyState).toBe(3);
  });

  it('dispatches event frames only to matching topic handlers', () => {
    const inventory = makeHandlers();
    const logs = makeHandlers();
    connection.subscribe('inventory', inventory);
    connection.subscribe('logs:s/abc', logs);
    sockets[0].fireOpen();

    sockets[0].fireMessage({ type: 'event', topic: 'inventory', kind: 'data', payload: { n: 1 } });

    expect(inventory.events).toHaveLength(1);
    expect(logs.events).toHaveLength(0);
  });

  it('delivers stats deltas and dropped frames to each subscribed stats topic', () => {
    const topics = ['stats:docker', 'stats:zfs', 'stats:proxmox'] as const;
    const perTopic = new Map<string, ReturnType<typeof makeHandlers>>();
    for (const topic of topics) perTopic.set(topic, makeHandlers());
    for (const [topic, handlers] of perTopic) connection.subscribe(topic, handlers);
    sockets[0].fireOpen();

    for (const topic of topics) {
      sockets[0].fireMessage({ type: 'event', topic, kind: 'data', payload: [{ time: 1 }] });
      sockets[0].fireMessage({ type: 'event', topic, kind: 'dropped', count: 2 });
    }

    for (const topic of topics) {
      expect(perTopic.get(topic)?.events).toEqual([
        { type: 'event', topic, kind: 'data', payload: [{ time: 1 }] },
        { type: 'event', topic, kind: 'dropped', count: 2 },
      ]);
    }
  });

  it('delivers the current status to new subscribers immediately', () => {
    connection.subscribe('inventory', makeHandlers());
    sockets[0].fireOpen();

    const late = makeHandlers();
    connection.subscribe('inventory', late);

    expect(late.statuses).toEqual([{ connected: true, error: null }]);
  });

  describe('reconnect with recorded timers', () => {
    const origSetTimeout = globalThis.setTimeout;
    const origClearTimeout = globalThis.clearTimeout;
    let pending: { fn: () => void; ms: number }[] = [];
    let scheduledDelays: number[] = [];

    beforeEach(() => {
      pending = [];
      scheduledDelays = [];
      let nextId = 1;
      // Recorded, not fired inline: an immediate fire runs the callback before
      // the handle assignment, making later schedules see a stale handle.
      spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
        pending.push({ fn, ms: ms ?? 0 });
        scheduledDelays.push(ms ?? 0);
        return nextId++;
      }) as unknown as typeof setTimeout);
      spyOn(globalThis, 'clearTimeout').mockImplementation((() => {}) as unknown as typeof clearTimeout);
    });

    afterEach(() => {
      (globalThis as unknown as Record<string, unknown>).setTimeout = origSetTimeout;
      (globalThis as unknown as Record<string, unknown>).clearTimeout = origClearTimeout;
    });

    const flushTimers = () => {
      const queue = pending;
      pending = [];
      for (const timer of queue) timer.fn();
    };

    it('reconnects with exponential backoff and resubscribes the full topic set', () => {
      connection.subscribe('inventory', makeHandlers());
      connection.subscribe('logs:s/abc', makeHandlers());
      sockets[0].fireOpen();

      sockets[0].fireClose();
      flushTimers();
      sockets[1].fireClose();
      flushTimers();
      sockets[2].fireOpen();

      expect(scheduledDelays).toEqual([1000, 2000]);
      expect(sockets).toHaveLength(3);
      expect(sockets[2].sent).toEqual([{ type: 'sub', ref: 1, topics: ['inventory', 'logs:s/abc'] }]);
    });

    it('surfaces an error status after repeated failures while still retrying', () => {
      const handler = makeHandlers();
      connection.subscribe('inventory', handler);
      sockets[0].fireOpen();

      for (let i = 0; i < 6; i++) {
        sockets[sockets.length - 1].fireClose();
        flushTimers();
      }

      const errorStatus = handler.statuses.find((status) => status.error !== null);
      expect(errorStatus?.error?.message).toBe('Connection failed after multiple attempts');
      expect(sockets.length).toBe(7);
    });

    it('clears the error and reports connected after recovery', () => {
      const handler = makeHandlers();
      connection.subscribe('inventory', handler);
      sockets[0].fireOpen();
      sockets[0].fireClose();
      flushTimers();
      sockets[1].fireOpen();

      expect(handler.statuses[handler.statuses.length - 1]).toEqual({ connected: true, error: null });
    });
  });
});

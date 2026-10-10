import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { mockModule } from '@/lib/test/mock-module';
import { MuxConnection, type MuxStatus, type MuxTopicHandlers, type MuxSubscribeError } from '@/lib/mux/mux-connection';
import { MAX_SUB_BATCH, type MuxEventFrame } from '@/lib/mux/protocol';

const mockToastError = mock((_message: string) => {});
mockModule<typeof import('sonner')>('sonner', (real) => ({ ...real, toast: { ...real.toast, error: mockToastError } }));

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

function makeHandlers(): MuxTopicHandlers & { events: MuxEventFrame[]; statuses: MuxStatus[]; rejections: MuxSubscribeError[] } {
  const events: MuxEventFrame[] = [];
  const statuses: MuxStatus[] = [];
  const rejections: MuxSubscribeError[] = [];
  return {
    events,
    statuses,
    rejections,
    onEvent: (frame) => { events.push(frame); },
    onStatus: (status) => { statuses.push(status); },
    onSubscribeRejected: (error) => { rejections.push(error); },
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

  describe('subscribe rejections', () => {
    let consoleError: ReturnType<typeof spyOn>;
    beforeEach(() => {
      mockToastError.mockReset();
      consoleError = spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      consoleError.mockRestore();
    });

    it('toasts the server message and notifies the topic with its machine-readable code', () => {
      const handlers = makeHandlers();
      connection.subscribe('inventory', handlers);
      sockets[0].fireOpen();

      sockets[0].fireMessage({ type: 'ack', ref: 0, ok: false, code: 'topic_limit', error: 'Session topic limit (250) reached. Unsubscribe unused topics.' });

      expect(handlers.rejections).toEqual([
        { topic: 'inventory', code: 'topic_limit', message: 'Session topic limit (250) reached. Unsubscribe unused topics.' },
      ]);
      expect(mockToastError).toHaveBeenCalledTimes(1);
      expect(mockToastError).toHaveBeenCalledWith('Session topic limit (250) reached. Unsubscribe unused topics.');
    });

    it('surfaces a generic error ack without a code', () => {
      const handlers = makeHandlers();
      connection.subscribe('inventory', handlers);
      sockets[0].fireOpen();

      sockets[0].fireMessage({ type: 'ack', ref: 0, ok: false, error: 'Invalid topic' });

      expect(handlers.rejections).toEqual([{ topic: 'inventory', code: undefined, message: 'Invalid topic' }]);
      expect(mockToastError).toHaveBeenCalledWith('Invalid topic');
    });

    it('surfaces unknown codes with a readable message when the ack carries no text', () => {
      const handlers = makeHandlers();
      connection.subscribe('inventory', handlers);
      sockets[0].fireOpen();

      sockets[0].fireMessage({ type: 'ack', ref: 0, ok: false, code: 'weird_new_limit' });

      expect(handlers.rejections).toEqual([{ topic: 'inventory', code: 'weird_new_limit', message: 'Subscription rejected (weird_new_limit)' }]);
      expect(mockToastError).toHaveBeenCalledWith('Subscription rejected (weird_new_limit)');
    });

    it('falls back to the topic_limit text when the ack carries a code but no message', () => {
      connection.subscribe('inventory', makeHandlers());
      sockets[0].fireOpen();

      sockets[0].fireMessage({ type: 'ack', ref: 0, ok: false, code: 'topic_limit' });

      expect(mockToastError).toHaveBeenCalledWith('Session topic limit reached. Unsubscribe unused topics.');
    });

    it('notifies every topic in a rejected batch and toasts once', () => {
      const inventory = makeHandlers();
      const logs = makeHandlers();
      connection.subscribe('inventory', inventory);
      connection.subscribe('logs:s/abc', logs);
      sockets[0].fireOpen();

      sockets[0].fireMessage({ type: 'ack', ref: 0, ok: false, code: 'topic_limit', error: 'Session topic limit (250) reached. Unsubscribe unused topics.' });

      expect(inventory.rejections.map((r) => r.topic)).toEqual(['inventory']);
      expect(logs.rejections.map((r) => r.topic)).toEqual(['logs:s/abc']);
      expect(mockToastError).toHaveBeenCalledTimes(1);
    });

    it('toasts an uncorrelated rejection without touching topic handlers and keeps the console error', () => {
      const handlers = makeHandlers();
      connection.subscribe('inventory', handlers);
      sockets[0].fireOpen();

      sockets[0].fireMessage({ type: 'ack', ref: 99, ok: false, error: 'Invalid command' });

      expect(handlers.rejections).toEqual([]);
      expect(mockToastError).toHaveBeenCalledWith('Invalid command');
      expect(consoleError).toHaveBeenCalled();
    });

    it('does not notify a handler that unsubscribed before the rejection arrived', () => {
      const stale = makeHandlers();
      const live = makeHandlers();
      const unsubStale = connection.subscribe('inventory', stale);
      connection.subscribe('logs:s/abc', live);
      sockets[0].fireOpen();
      unsubStale();

      sockets[0].fireMessage({ type: 'ack', ref: 0, ok: false, code: 'topic_limit', error: 'Session topic limit (250) reached. Unsubscribe unused topics.' });

      expect(stale.rejections).toEqual([]);
      expect(live.rejections.map((r) => r.topic)).toEqual(['logs:s/abc']);
      expect(mockToastError).toHaveBeenCalledTimes(1);
    });

    it('splits a resubscribe burst into server-sized frames', () => {
      const topics = Array.from({ length: 2 * MAX_SUB_BATCH + 5 }, (_, i) => `logs:s/c${i}`);
      for (const topic of topics) connection.subscribe(topic, makeHandlers());
      sockets[0].fireOpen();

      const sent = sockets[0].sent as { topics: string[] }[];
      expect(sent).toHaveLength(Math.ceil(topics.length / MAX_SUB_BATCH));
      expect(sent.every((frame) => frame.topics.length <= MAX_SUB_BATCH)).toBe(true);
      expect(sent.flatMap((frame) => frame.topics)).toEqual(topics);
    });
  });
});

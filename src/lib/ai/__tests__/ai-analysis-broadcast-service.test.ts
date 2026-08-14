import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import type { PoolClient } from 'pg';
import { AiAnalysisBroadcastService } from '@/lib/ai/ai-analysis-broadcast-service';
import type { AiAnalysisSnapshot } from '@/types/ai';

const EMPTY: AiAnalysisSnapshot = { profiles: [], sessions: [], observations: [], alerts: [] };

interface FakeClient {
  handlers: Map<string, ((arg: unknown) => void)[]>;
  query: ReturnType<typeof mock>;
  release: ReturnType<typeof mock>;
  removeAllListeners: ReturnType<typeof mock>;
  emit: (event: string, arg: unknown) => void;
}

function fakeClient(): FakeClient {
  const handlers = new Map<string, ((arg: unknown) => void)[]>();
  return {
    handlers,
    on(event: string, handler: (arg: unknown) => void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    query: mock(async () => ({ rows: [] })),
    release: mock(() => {}),
    removeAllListeners: mock(() => {}),
    emit(event: string, arg: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(arg);
    },
  } as unknown as FakeClient;
}

/** Captured before the suite stubs the global, so draining still works. */
const realSetTimeout = globalThis.setTimeout;

/** Lets every promise the service has in flight settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, 0));
}

describe('AiAnalysisBroadcastService', () => {
  let errorSpy: ReturnType<typeof spyOn>;
  let timeouts: (() => void)[];

  beforeEach(() => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    timeouts = [];
    // Collect every scheduled callback so coalescing and reconnect
    // backoff are observable without waiting on real time.
    globalThis.setTimeout = ((fn: () => void) => {
      timeouts.push(fn);
      return timeouts.length as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
  });

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
    errorSpy.mockRestore();
  });

  function runTimers(): void {
    const pending = timeouts;
    timeouts = [];
    for (const fn of pending) fn();
  }

  it('sends the current snapshot to the first subscriber and registers LISTEN', async () => {
    const client = fakeClient();
    const snapshot = { ...EMPTY, alerts: [] };
    const service = new AiAnalysisBroadcastService({
      getPoolClient: async () => client as unknown as PoolClient,
      loadSnapshot: async () => snapshot,
    });

    const received: AiAnalysisSnapshot[] = [];
    service.subscribe((next) => received.push(next));
    await flush();

    expect(received).toEqual([snapshot]);
    expect(client.query.mock.calls[0][0]).toBe('LISTEN ai_analysis_change');
  });

  it('serves a later subscriber without reopening a listener', async () => {
    const client = fakeClient();
    const getPoolClient = mock(async () => client as unknown as PoolClient);
    const service = new AiAnalysisBroadcastService({ getPoolClient, loadSnapshot: async () => EMPTY });

    service.subscribe(() => {});
    await flush();
    const received: AiAnalysisSnapshot[] = [];
    service.subscribe((next) => received.push(next));
    await flush();

    expect(received).toHaveLength(1);
    expect(getPoolClient).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst of notifications into one reload', async () => {
    const client = fakeClient();
    const loadSnapshot = mock(async () => EMPTY);
    const service = new AiAnalysisBroadcastService({
      getPoolClient: async () => client as unknown as PoolClient,
      loadSnapshot,
    });

    service.subscribe(() => {});
    await flush();
    loadSnapshot.mockClear();

    client.emit('notification', { channel: 'ai_analysis_change' });
    client.emit('notification', { channel: 'ai_analysis_change' });
    client.emit('notification', { channel: 'ai_analysis_change' });
    runTimers();
    await flush();

    expect(loadSnapshot).toHaveBeenCalledTimes(1);
  });

  it('ignores notifications from other channels', async () => {
    const client = fakeClient();
    const loadSnapshot = mock(async () => EMPTY);
    const service = new AiAnalysisBroadcastService({
      getPoolClient: async () => client as unknown as PoolClient,
      loadSnapshot,
    });

    service.subscribe(() => {});
    await flush();
    loadSnapshot.mockClear();

    client.emit('notification', { channel: 'docker_container_change' });
    runTimers();
    await flush();

    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it('stops listening when the last subscriber leaves', async () => {
    const client = fakeClient();
    const service = new AiAnalysisBroadcastService({
      getPoolClient: async () => client as unknown as PoolClient,
      loadSnapshot: async () => EMPTY,
    });

    const unsubscribe = service.subscribe(() => {});
    await flush();
    unsubscribe();

    expect(client.query.mock.calls.at(-1)?.[0]).toBe('UNLISTEN ai_analysis_change');
    expect(client.release).toHaveBeenCalled();
  });

  it('schedules a reconnect when the listener client errors', async () => {
    const first = fakeClient();
    const second = fakeClient();
    const clients = [first, second];
    const getPoolClient = mock(async () => clients.shift() as unknown as PoolClient);
    const service = new AiAnalysisBroadcastService({ getPoolClient, loadSnapshot: async () => EMPTY });

    service.subscribe(() => {});
    await flush();

    first.emit('error', new Error('connection lost'));
    runTimers();
    await flush();

    expect(getPoolClient).toHaveBeenCalledTimes(2);
    expect(second.query.mock.calls[0][0]).toBe('LISTEN ai_analysis_change');
  });

  it('schedules a reconnect when acquiring the client fails', async () => {
    const client = fakeClient();
    let attempt = 0;
    const getPoolClient = mock(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('pool exhausted');
      return client as unknown as PoolClient;
    });
    const service = new AiAnalysisBroadcastService({ getPoolClient, loadSnapshot: async () => EMPTY });

    service.subscribe(() => {});
    await flush();
    runTimers();
    await flush();

    expect(getPoolClient).toHaveBeenCalledTimes(2);
  });

  it('schedules a reconnect when LISTEN itself fails', async () => {
    const failing = fakeClient();
    failing.query = mock(async () => {
      throw new Error('LISTEN denied');
    }) as unknown as FakeClient['query'];
    const healthy = fakeClient();
    const clients: FakeClient[] = [failing, healthy];
    const getPoolClient = mock(async () => clients.shift() as unknown as PoolClient);
    const service = new AiAnalysisBroadcastService({ getPoolClient, loadSnapshot: async () => EMPTY });

    service.subscribe(() => {});
    await flush();
    runTimers();
    await flush();

    expect(getPoolClient).toHaveBeenCalledTimes(2);
  });

  it('logs rather than throwing when the snapshot load fails', async () => {
    const client = fakeClient();
    const service = new AiAnalysisBroadcastService({
      getPoolClient: async () => client as unknown as PoolClient,
      loadSnapshot: async () => {
        throw new Error('db down');
      },
    });

    const received: AiAnalysisSnapshot[] = [];
    service.subscribe((next) => received.push(next));
    await flush();

    expect(received).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('does not deliver to a subscriber that left during the load', async () => {
    const client = fakeClient();
    let resolveLoad: (snapshot: AiAnalysisSnapshot) => void = () => {};
    const service = new AiAnalysisBroadcastService({
      getPoolClient: async () => client as unknown as PoolClient,
      loadSnapshot: () =>
        new Promise<AiAnalysisSnapshot>((resolve) => {
          resolveLoad = resolve;
        }),
    });

    const received: AiAnalysisSnapshot[] = [];
    const unsubscribe = service.subscribe((next) => received.push(next));
    await flush();
    unsubscribe();
    resolveLoad(EMPTY);
    await flush();

    expect(received).toEqual([]);
  });
});

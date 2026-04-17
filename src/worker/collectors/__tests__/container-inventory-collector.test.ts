import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { ContainerInventoryCollector } from '../container-inventory-collector';
import type { DockerContainerEventRepository, NewContainerEvent } from '@/lib/database/repositories/docker-container-event-repository';
import type { ManagedHostInfo } from '../stack-status-collector';
import type { DockerContainerEventRow } from '@/lib/database/repositories/docker-container-event-repository';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const HOST: ManagedHostInfo = { name: 'homeserver', agentUrl: 'http://192.168.1.10:9090' };

function makeRow(overrides: Partial<DockerContainerEventRow> = {}): DockerContainerEventRow {
  return {
    at: new Date(),
    host: 'homeserver',
    containerId: 'abc123',
    eventType: 'upsert',
    state: 'running',
    name: 'plex',
    image: 'plexinc/pms-docker:latest',
    labels: {},
    composeProject: null,
    serviceKey: 'plex',
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    ...overrides,
  };
}

function makeContainer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'abc123',
    name: 'plex',
    image: 'plexinc/pms-docker:latest',
    state: 'running' as const,
    labels: {},
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    ...overrides,
  };
}

function createMockRepo(snapshotRows: DockerContainerEventRow[] = []) {
  const inserted: NewContainerEvent[] = [];
  const repo = {
    insert: mock(async (event: NewContainerEvent) => {
      inserted.push(event);
      return makeRow({ eventType: event.eventType, state: event.state, containerId: event.containerId });
    }),
    getCurrentSnapshot: mock(async () => snapshotRows),
    getLatestForContainer: mock(async () => null),
    getHistoryForContainer: mock(async () => []),
  } as unknown as DockerContainerEventRepository;
  return { repo, inserted };
}

function createMockSSEStream(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
}

function createNeverEndingStream(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      // Never close — collector runs until aborted
    },
  });
}

function createErrorStream(error: Error): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.error(error);
    },
  });
}

/** Spy that makes setTimeout fire its callback immediately. */
function spyImmediateTimeout() {
  return spyOn(globalThis, 'setTimeout').mockImplementation(
    ((fn: TimerHandler) => {
      if (typeof fn === 'function') fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout,
  );
}

describe('ContainerInventoryCollector — state-change dedup', () => {
  let abortController: AbortController;
  let setTimeoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    abortController = new AbortController();
    setTimeoutSpy = spyImmediateTimeout();
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
    abortController.abort();
  });

  it('upsert with new state writes one row', async () => {
    const { repo, inserted } = createMockRepo();
    const upsertEvent = { op: 'upsert', container: makeContainer({ state: 'running' }) };
    const fetchFn: FetchFn = mock(async () =>
      new Response(createMockSSEStream([upsertEvent]), { status: 200 })
    );

    const collector = new ContainerInventoryCollector(HOST, 'tok', repo, abortController, fetchFn);
    await (collector as any).collect();

    expect(inserted).toHaveLength(1);
    expect(inserted[0].eventType).toBe('upsert');
    expect(inserted[0].state).toBe('running');
  });

  it('upsert with same state as cache writes zero rows', async () => {
    const snapshot = [makeRow({ containerId: 'abc123', state: 'running', eventType: 'upsert' })];
    const { repo, inserted } = createMockRepo(snapshot);
    const upsertEvent = { op: 'upsert', container: makeContainer({ state: 'running' }) };
    const fetchFn: FetchFn = mock(async () =>
      new Response(createMockSSEStream([upsertEvent]), { status: 200 })
    );

    const collector = new ContainerInventoryCollector(HOST, 'tok', repo, abortController, fetchFn);
    await (collector as any).hydrateCache();
    await (collector as any).collect();

    expect(inserted).toHaveLength(0);
  });

  it('state change (running → exited) writes one row', async () => {
    const snapshot = [makeRow({ containerId: 'abc123', state: 'running', eventType: 'upsert' })];
    const { repo, inserted } = createMockRepo(snapshot);
    const upsertEvent = { op: 'upsert', container: makeContainer({ state: 'exited', exitCode: 0, finishedAt: '2026-04-16T10:01:00Z' }) };
    const fetchFn: FetchFn = mock(async () =>
      new Response(createMockSSEStream([upsertEvent]), { status: 200 })
    );

    const collector = new ContainerInventoryCollector(HOST, 'tok', repo, abortController, fetchFn);
    await (collector as any).hydrateCache();
    await (collector as any).collect();

    expect(inserted).toHaveLength(1);
    expect(inserted[0].state).toBe('exited');
    expect(inserted[0].exitCode).toBe(0);
  });

  it('destroy event writes one destroy row regardless of prior state', async () => {
    const snapshot = [makeRow({ containerId: 'abc123', state: 'running', eventType: 'upsert' })];
    const { repo, inserted } = createMockRepo(snapshot);
    const destroyEvent = { op: 'destroy', containerId: 'abc123' };
    const fetchFn: FetchFn = mock(async () =>
      new Response(createMockSSEStream([destroyEvent]), { status: 200 })
    );

    const collector = new ContainerInventoryCollector(HOST, 'tok', repo, abortController, fetchFn);
    await (collector as any).hydrateCache();
    await (collector as any).collect();

    expect(inserted).toHaveLength(1);
    expect(inserted[0].eventType).toBe('destroy');
    expect(inserted[0].containerId).toBe('abc123');
    expect(inserted[0].state).toBeNull();
  });

  it('destroy event with no prior cache still writes one destroy row', async () => {
    const { repo, inserted } = createMockRepo();
    const destroyEvent = { op: 'destroy', containerId: 'abc123' };
    const fetchFn: FetchFn = mock(async () =>
      new Response(createMockSSEStream([destroyEvent]), { status: 200 })
    );

    const collector = new ContainerInventoryCollector(HOST, 'tok', repo, abortController, fetchFn);
    await (collector as any).collect();

    expect(inserted).toHaveLength(1);
    expect(inserted[0].eventType).toBe('destroy');
  });
});

describe('ContainerInventoryCollector — flap dampening', () => {
  let abortController: AbortController;

  beforeEach(() => {
    abortController = new AbortController();
  });

  afterEach(() => {
    abortController.abort();
  });

  it('scheduleDestroyWrite skips write when cache already records destroy', async () => {
    const timers: Array<{ fn: TimerHandler; id: number }> = [];
    let idCounter = 0;
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      ((fn: TimerHandler) => {
        const id = ++idCounter;
        timers.push({ fn, id });
        return id as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
    );
    const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});

    const snapshot = [makeRow({ containerId: 'abc123', state: null, eventType: 'destroy' })];
    const { repo, inserted } = createMockRepo(snapshot);

    const collector = new ContainerInventoryCollector(HOST, 'tok', repo, abortController);
    await (collector as any).hydrateCache();

    (collector as any).scheduleDestroyWrite('abc123');
    expect(timers).toHaveLength(1);

    const { fn } = timers[0];
    timers.splice(0, 1);
    await (typeof fn === 'function' ? Promise.resolve(fn()) : Promise.resolve());

    expect(inserted).toHaveLength(0);

    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  it('flap (A→B→A within window) collapses to zero writes', async () => {
    const timers: Array<{ fn: TimerHandler; delay: number; id: number }> = [];
    let idCounter = 0;
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      ((fn: TimerHandler, delay?: number) => {
        const id = ++idCounter;
        timers.push({ fn, delay: delay ?? 0, id });
        return id as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
    );
    const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout').mockImplementation((id) => {
      const idx = timers.findIndex((t) => t.id === id);
      if (idx !== -1) timers.splice(idx, 1);
    });

    const snapshot = [makeRow({ containerId: 'abc123', state: 'running', eventType: 'upsert' })];
    const { repo, inserted } = createMockRepo(snapshot);

    const collector = new ContainerInventoryCollector(HOST, 'tok', repo, abortController);
    await (collector as any).hydrateCache();

    // A→B (exited)
    (collector as any).scheduleWrite(makeContainer({ state: 'exited' }), 'upsert');
    expect(timers).toHaveLength(1);

    // B→A (running) — cancels prior timer, schedules new one
    (collector as any).scheduleWrite(makeContainer({ state: 'running' }), 'upsert');
    expect(timers).toHaveLength(1);

    // Fire the surviving timer (state = running, same as cache → no write)
    const { fn } = timers[0];
    timers.splice(0, 1);
    if (typeof fn === 'function') fn();

    expect(inserted).toHaveLength(0);

    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  it('single transition (A→B) writes one row after the window fires', async () => {
    const timers: Array<{ fn: TimerHandler; id: number }> = [];
    let idCounter = 0;
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      ((fn: TimerHandler) => {
        const id = ++idCounter;
        timers.push({ fn, id });
        return id as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
    );
    const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});

    const snapshot = [makeRow({ containerId: 'abc123', state: 'running', eventType: 'upsert' })];
    const { repo, inserted } = createMockRepo(snapshot);

    const collector = new ContainerInventoryCollector(HOST, 'tok', repo, abortController);
    await (collector as any).hydrateCache();

    (collector as any).scheduleWrite(makeContainer({ state: 'exited' }), 'upsert');
    expect(timers).toHaveLength(1);

    const { fn } = timers[0];
    timers.splice(0, 1);
    await (typeof fn === 'function' ? Promise.resolve(fn()) : Promise.resolve());

    expect(inserted).toHaveLength(1);
    expect(inserted[0].state).toBe('exited');

    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });
});

describe('ContainerInventoryCollector — init reconciliation', () => {
  let abortController: AbortController;
  let setTimeoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    abortController = new AbortController();
    setTimeoutSpy = spyImmediateTimeout();
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
    abortController.abort();
  });

  it('init snapshot hydrates cache and writes upserts for changed containers', async () => {
    const snapshot = [makeRow({ containerId: 'abc123', state: 'running', eventType: 'upsert' })];
    const { repo, inserted } = createMockRepo(snapshot);
    const initEvent = { op: 'init', containers: [makeContainer({ state: 'exited' })] };
    const fetchFn: FetchFn = mock(async () =>
      new Response(createMockSSEStream([initEvent]), { status: 200 })
    );

    const collector = new ContainerInventoryCollector(HOST, 'tok', repo, abortController, fetchFn);
    await (collector as any).hydrateCache();
    await (collector as any).collect();

    expect(inserted).toHaveLength(1);
    expect(inserted[0].state).toBe('exited');
    expect(inserted[0].eventType).toBe('upsert');
  });

  it('init writes destroy for containers missing from snapshot (went offline)', async () => {
    const snapshot = [makeRow({ containerId: 'abc123', state: 'running', eventType: 'upsert' })];
    const { repo, inserted } = createMockRepo(snapshot);
    const initEvent = { op: 'init', containers: [] };
    const fetchFn: FetchFn = mock(async () =>
      new Response(createMockSSEStream([initEvent]), { status: 200 })
    );

    const collector = new ContainerInventoryCollector(HOST, 'tok', repo, abortController, fetchFn);
    await (collector as any).hydrateCache();
    await (collector as any).collect();

    expect(inserted).toHaveLength(1);
    expect(inserted[0].eventType).toBe('destroy');
    expect(inserted[0].containerId).toBe('abc123');
  });

  it('init does not write for containers whose state is unchanged', async () => {
    const snapshot = [makeRow({ containerId: 'abc123', state: 'running', eventType: 'upsert' })];
    const { repo, inserted } = createMockRepo(snapshot);
    const initEvent = { op: 'init', containers: [makeContainer({ state: 'running' })] };
    const fetchFn: FetchFn = mock(async () =>
      new Response(createMockSSEStream([initEvent]), { status: 200 })
    );

    const collector = new ContainerInventoryCollector(HOST, 'tok', repo, abortController, fetchFn);
    await (collector as any).hydrateCache();
    await (collector as any).collect();

    expect(inserted).toHaveLength(0);
  });

  it('init does not write destroy for containers already marked destroy in cache', async () => {
    const snapshot = [makeRow({ containerId: 'abc123', state: null, eventType: 'destroy' })];
    const { repo, inserted } = createMockRepo(snapshot);
    const initEvent = { op: 'init', containers: [] };
    const fetchFn: FetchFn = mock(async () =>
      new Response(createMockSSEStream([initEvent]), { status: 200 })
    );

    const collector = new ContainerInventoryCollector(HOST, 'tok', repo, abortController, fetchFn);
    await (collector as any).hydrateCache();
    await (collector as any).collect();

    expect(inserted).toHaveLength(0);
  });

  it('hydrateCache only populates cache for entries matching this host', async () => {
    const snapshot = [
      makeRow({ host: 'homeserver', containerId: 'abc123', state: 'running', eventType: 'upsert' }),
      makeRow({ host: 'otherhost', containerId: 'def456', state: 'paused', eventType: 'upsert' }),
    ];
    const { repo } = createMockRepo(snapshot);

    const collector = new ContainerInventoryCollector(HOST, 'tok', repo, abortController);
    await (collector as any).hydrateCache();

    const cache: Map<string, unknown> = (collector as any).stateCache;
    expect(cache.has('abc123')).toBe(true);
    expect(cache.has('def456')).toBe(false);
  });
});

describe('ContainerInventoryCollector — reconnection and abort', () => {
  let abortController: AbortController;

  beforeEach(() => {
    abortController = new AbortController();
  });

  afterEach(() => {
    abortController.abort();
  });

  it('reconnects after SSE error with exponential backoff', async () => {
    let callCount = 0;
    const setTimeoutSpy = spyImmediateTimeout();

    const { repo } = createMockRepo();
    const fetchFn: FetchFn = mock(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(createErrorStream(new Error('Connection reset')), { status: 200 });
      }
      abortController.abort();
      return new Response(createMockSSEStream([]), { status: 200 });
    });

    const collector = new ContainerInventoryCollector(HOST, 'tok', repo, abortController, fetchFn);
    await collector.run();

    expect(callCount).toBeGreaterThanOrEqual(2);
    setTimeoutSpy.mockRestore();
  });

  it('stops cleanly when abort signal fires', async () => {
    const { repo } = createMockRepo();
    const fetchFn: FetchFn = mock(async () => {
      abortController.abort();
      return new Response(createNeverEndingStream([]), { status: 200 });
    });

    const collector = new ContainerInventoryCollector(HOST, 'tok', repo, abortController, fetchFn);
    await collector.run();

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('throws on non-200 response and triggers reconnect', async () => {
    let callCount = 0;
    const setTimeoutSpy = spyImmediateTimeout();
    const { repo } = createMockRepo();
    const fetchFn: FetchFn = mock(async () => {
      callCount++;
      if (callCount <= 2) {
        return new Response('Not Found', { status: 404 });
      }
      abortController.abort();
      return new Response(createMockSSEStream([]), { status: 200 });
    });

    const collector = new ContainerInventoryCollector(HOST, 'tok', repo, abortController, fetchFn);
    await collector.run();

    expect(callCount).toBeGreaterThanOrEqual(3);
    setTimeoutSpy.mockRestore();
  });

  it('abort before run starts causes immediate exit', async () => {
    const controller = new AbortController();
    controller.abort();
    const { repo } = createMockRepo();
    const fetchFn: FetchFn = mock(async () => new Response(createMockSSEStream([]), { status: 200 }));

    const collector = new ContainerInventoryCollector(HOST, 'tok', repo, controller, fetchFn);
    await collector.run();

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('asyncDispose aborts the collector', async () => {
    const { repo } = createMockRepo();
    const collector = new ContainerInventoryCollector(HOST, 'tok', repo, abortController);
    expect(collector.signal.aborted).toBe(false);

    await collector[Symbol.asyncDispose]();

    expect(collector.signal.aborted).toBe(true);
  });

  it('sends Authorization Bearer header', async () => {
    const { repo } = createMockRepo();
    const fetchFn: FetchFn = mock(async () => {
      abortController.abort();
      return new Response(createMockSSEStream([]), { status: 200 });
    });

    const collector = new ContainerInventoryCollector(HOST, 'secret-token', repo, abortController, fetchFn);
    await (collector as any).collect().catch(() => {});

    const mockFn = fetchFn as unknown as { mock: { calls: unknown[][] } };
    const callArgs = mockFn.mock.calls[0] as [string, RequestInit];
    expect(callArgs[0]).toBe('http://192.168.1.10:9090/containers/events');
    expect((callArgs[1].headers as Record<string, string>)['Authorization']).toBe('Bearer secret-token');
  });

  it('skips malformed JSON in SSE events', async () => {
    const setTimeoutSpy = spyImmediateTimeout();

    const { repo, inserted } = createMockRepo();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: {not valid json}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ op: 'upsert', container: makeContainer() })}\n\n`));
        controller.close();
      },
    });
    const fetchFn: FetchFn = mock(async () => new Response(stream, { status: 200 }));

    const collector = new ContainerInventoryCollector(HOST, 'tok', repo, abortController, fetchFn);
    await (collector as any).collect();

    expect(inserted).toHaveLength(1);
    setTimeoutSpy.mockRestore();
  });
});

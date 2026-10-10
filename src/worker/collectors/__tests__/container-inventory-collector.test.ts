import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { ContainerInventoryCollector } from '../container-inventory-collector';
import type { DockerContainerEventRepository, NewContainerEvent } from '@/lib/database/repositories/docker-container-event-repository';
import type { ManagedHostInfo } from '../container-inventory-collector';
import type { DockerContainerEventRow } from '@/lib/database/repositories/docker-container-event-repository';
import { fixedStream, type StreamConnector } from '@/lib/test/agent-sse-stream-fixtures';
import { mockSetTimeout, type TimerMock } from '@/lib/test/mock-timers';

/**
 * Stream connector whose generator never completes on its own; it only ends
 * when the caller's abort signal fires, mirroring how the real connector's
 * `reader.read()` rejects once the underlying fetch is cancelled.
 */
function neverEndingStream(frames: unknown[]): StreamConnector {
  return async function* (options: { signal: AbortSignal }) {
    for (const frame of frames) yield frame;
    await new Promise<void>((resolve) => {
      if (options.signal.aborted) { resolve(); return; }
      options.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  } as unknown as StreamConnector;
}

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
    ports: [],
    mounts: [],
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
    ports: [],
    mounts: [],
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
      if (event.eventType === 'destroy') {
        return makeRow({ eventType: 'destroy', containerId: event.containerId });
      }
      return makeRow({ eventType: 'upsert', state: event.state, containerId: event.containerId });
    }),
    getCurrentSnapshot: mock(async () => snapshotRows),
  } as unknown as DockerContainerEventRepository;
  return { repo, inserted };
}

describe('ContainerInventoryCollector: state-change dedup', () => {
  let abortController: AbortController;
  let timers: TimerMock;

  beforeEach(() => {
    abortController = new AbortController();
    timers = mockSetTimeout({ fireImmediately: true });
  });

  afterEach(() => {
    timers.restore();
    abortController.abort();
  });

  it('upsert with new state writes one row', async () => {
    const { repo, inserted } = createMockRepo();
    const upsertEvent = { op: 'upsert', container: makeContainer({ state: 'running' }) };
    const streamConnector = fixedStream([upsertEvent]);

    const collector = new ContainerInventoryCollector(HOST, async () => 'tok', repo, abortController, streamConnector);
    await (collector as any).collect();

    expect(inserted).toHaveLength(1);
    expect(inserted[0].eventType).toBe('upsert');
    expect(inserted[0].eventType === 'upsert' && inserted[0].state).toBe('running');
  });

  it('upsert with same state as cache writes zero rows', async () => {
    const snapshot = [makeRow({ containerId: 'abc123', state: 'running', eventType: 'upsert' })];
    const { repo, inserted } = createMockRepo(snapshot);
    const upsertEvent = { op: 'upsert', container: makeContainer({ state: 'running' }) };
    const streamConnector = fixedStream([upsertEvent]);

    const collector = new ContainerInventoryCollector(HOST, async () => 'tok', repo, abortController, streamConnector);
    await (collector as any).hydrateCache();
    await (collector as any).collect();

    expect(inserted).toHaveLength(0);
  });

  it('state change (running → exited) writes one row', async () => {
    const snapshot = [makeRow({ containerId: 'abc123', state: 'running', eventType: 'upsert' })];
    const { repo, inserted } = createMockRepo(snapshot);
    const upsertEvent = { op: 'upsert', container: makeContainer({ state: 'exited', exitCode: 0, finishedAt: '2026-04-16T10:01:00Z' }) };
    const streamConnector = fixedStream([upsertEvent]);

    const collector = new ContainerInventoryCollector(HOST, async () => 'tok', repo, abortController, streamConnector);
    await (collector as any).hydrateCache();
    await (collector as any).collect();

    expect(inserted).toHaveLength(1);
    expect(inserted[0].eventType === 'upsert' && inserted[0].state).toBe('exited');
    expect(inserted[0].eventType === 'upsert' && inserted[0].exitCode).toBe(0);
  });

  it('destroy event writes one destroy row regardless of prior state', async () => {
    const snapshot = [makeRow({ containerId: 'abc123', state: 'running', eventType: 'upsert' })];
    const { repo, inserted } = createMockRepo(snapshot);
    const destroyEvent = { op: 'destroy', containerId: 'abc123' };
    const streamConnector = fixedStream([destroyEvent]);

    const collector = new ContainerInventoryCollector(HOST, async () => 'tok', repo, abortController, streamConnector);
    await (collector as any).hydrateCache();
    await (collector as any).collect();

    expect(inserted).toHaveLength(1);
    expect(inserted[0].eventType).toBe('destroy');
    expect(inserted[0].containerId).toBe('abc123');
    // destroy events carry no state field in the discriminated union
    expect(inserted[0].eventType === 'destroy' && !('state' in inserted[0])).toBe(true);
  });

  it('destroy event with no prior cache still writes one destroy row', async () => {
    const { repo, inserted } = createMockRepo();
    const destroyEvent = { op: 'destroy', containerId: 'abc123' };
    const streamConnector = fixedStream([destroyEvent]);

    const collector = new ContainerInventoryCollector(HOST, async () => 'tok', repo, abortController, streamConnector);
    await (collector as any).collect();

    expect(inserted).toHaveLength(1);
    expect(inserted[0].eventType).toBe('destroy');
  });
});

describe('ContainerInventoryCollector: ports/mounts fingerprinting', () => {
  let abortController: AbortController;
  let timers: TimerMock;

  beforeEach(() => {
    abortController = new AbortController();
    timers = mockSetTimeout({ fireImmediately: true });
  });

  afterEach(() => {
    timers.restore();
    abortController.abort();
  });

  it('insert carries ports and mounts from the live frame', async () => {
    const { repo, inserted } = createMockRepo();
    const container = makeContainer({
      ports: [{ containerPort: 80, protocol: 'tcp', hostIp: null, hostPort: 8080 }],
      mounts: [{ type: 'volume', source: 'app-data', destination: '/data', rw: true }],
    });
    const streamConnector = fixedStream([{ op: 'upsert', container }]);

    const collector = new ContainerInventoryCollector(HOST, async () => 'tok', repo, abortController, streamConnector);
    await (collector as any).collect();

    expect(inserted).toHaveLength(1);
    const event = inserted[0];
    if (event.eventType !== 'upsert') throw new Error('expected upsert row');
    expect(event.ports).toEqual(container.ports);
    expect(event.mounts).toEqual(container.mounts);
  });

  it('hydrated cache fingerprint matches a live frame with the same content but reordered jsonb keys', async () => {
    // Simulates a DB row where jsonb round-trip reordered object keys; values are identical
    // to the live frame below but property insertion order differs.
    const dbRowPort = { hostPort: 8080, hostIp: null, protocol: 'tcp', containerPort: 80 };
    const dbRowMount = { rw: true, destination: '/data', source: 'app-data', type: 'volume' };
    const snapshot = [makeRow({
      containerId: 'abc123',
      state: 'running',
      eventType: 'upsert',
      ports: [dbRowPort],
      mounts: [dbRowMount],
    })];
    const { repo, inserted } = createMockRepo(snapshot);

    const liveContainer = makeContainer({
      state: 'running',
      ports: [{ containerPort: 80, protocol: 'tcp', hostIp: null, hostPort: 8080 }],
      mounts: [{ type: 'volume', source: 'app-data', destination: '/data', rw: true }],
    });
    const streamConnector = fixedStream([{ op: 'upsert', container: liveContainer }]);

    const collector = new ContainerInventoryCollector(HOST, async () => 'tok', repo, abortController, streamConnector);
    await (collector as any).hydrateCache();
    await (collector as any).collect();

    expect(inserted).toHaveLength(0);
  });

  it('reconcileInit writes exactly once when fingerprint differs from a legacy empty-array row', async () => {
    const snapshot = [makeRow({ containerId: 'abc123', state: 'running', eventType: 'upsert', ports: [], mounts: [] })];
    const { repo, inserted } = createMockRepo(snapshot);
    const container = makeContainer({
      state: 'running',
      ports: [{ containerPort: 443, protocol: 'tcp', hostIp: null, hostPort: 443 }],
    });

    const collector = new ContainerInventoryCollector(HOST, async () => 'tok', repo, abortController);
    await (collector as any).hydrateCache();
    await (collector as any).reconcileInit([container]);

    expect(inserted).toHaveLength(1);
    const event = inserted[0];
    if (event.eventType !== 'upsert') throw new Error('expected upsert row');
    expect(event.ports).toEqual(container.ports);
  });

  it('reconcileInit writes nothing when state and fingerprint both match', async () => {
    const snapshot = [makeRow({
      containerId: 'abc123',
      state: 'running',
      eventType: 'upsert',
      ports: [{ containerPort: 443, protocol: 'tcp', hostIp: null, hostPort: 443 }],
      mounts: [],
    })];
    const { repo, inserted } = createMockRepo(snapshot);
    const container = makeContainer({
      state: 'running',
      ports: [{ containerPort: 443, protocol: 'tcp', hostIp: null, hostPort: 443 }],
    });

    const collector = new ContainerInventoryCollector(HOST, async () => 'tok', repo, abortController);
    await (collector as any).hydrateCache();
    await (collector as any).reconcileInit([container]);

    expect(inserted).toHaveLength(0);
  });

  it('old-agent frame lacking ports/mounts fields defaults to [] and causes no write against a [] cached row', async () => {
    const snapshot = [makeRow({ containerId: 'abc123', state: 'running', eventType: 'upsert', ports: [], mounts: [] })];
    const { repo, inserted } = createMockRepo(snapshot);
    // Raw frame with no ports/mounts keys at all, as an old agent would send; zod fills [] defaults.
    const legacyFrame = {
      op: 'upsert',
      container: {
        id: 'abc123',
        name: 'plex',
        image: 'plexinc/pms-docker:latest',
        state: 'running',
        labels: {},
        startedAt: null,
        finishedAt: null,
        exitCode: null,
      },
    };
    const streamConnector = fixedStream([legacyFrame]);

    const collector = new ContainerInventoryCollector(HOST, async () => 'tok', repo, abortController, streamConnector);
    await (collector as any).hydrateCache();
    await (collector as any).collect();

    expect(inserted).toHaveLength(0);
  });
});

describe('ContainerInventoryCollector: flap dampening', () => {
  let abortController: AbortController;

  beforeEach(() => {
    abortController = new AbortController();
  });

  afterEach(() => {
    abortController.abort();
  });

  it('scheduleDestroyWrite skips write when cache already records destroy', async () => {
    const timers = mockSetTimeout();

    const snapshot = [makeRow({ containerId: 'abc123', eventType: 'destroy' })];
    const { repo, inserted } = createMockRepo(snapshot);

    const collector = new ContainerInventoryCollector(HOST, async () => 'tok', repo, abortController);
    await (collector as any).hydrateCache();

    (collector as any).scheduleDestroyWrite('abc123');
    expect(timers.pending).toHaveLength(1);

    await timers.fire(timers.pending[0]);

    expect(inserted).toHaveLength(0);

    timers.restore();
  });

  it('flap (A→B→A within window) collapses to zero writes', async () => {
    const timers = mockSetTimeout();

    const snapshot = [makeRow({ containerId: 'abc123', state: 'running', eventType: 'upsert' })];
    const { repo, inserted } = createMockRepo(snapshot);

    const collector = new ContainerInventoryCollector(HOST, async () => 'tok', repo, abortController);
    await (collector as any).hydrateCache();

    // A→B (exited)
    (collector as any).scheduleWrite(makeContainer({ state: 'exited' }), 'upsert');
    expect(timers.pending).toHaveLength(1);

    // B→A (running): cancels prior timer, schedules new one
    (collector as any).scheduleWrite(makeContainer({ state: 'running' }), 'upsert');
    expect(timers.pending).toHaveLength(1);

    // Fire the surviving timer (state = running, same as cache → no write)
    timers.fire(timers.pending[0]);

    expect(inserted).toHaveLength(0);

    timers.restore();
  });

  it('single transition (A→B) writes one row after the window fires', async () => {
    const timers = mockSetTimeout();

    const snapshot = [makeRow({ containerId: 'abc123', state: 'running', eventType: 'upsert' })];
    const { repo, inserted } = createMockRepo(snapshot);

    const collector = new ContainerInventoryCollector(HOST, async () => 'tok', repo, abortController);
    await (collector as any).hydrateCache();

    (collector as any).scheduleWrite(makeContainer({ state: 'exited' }), 'upsert');
    expect(timers.pending).toHaveLength(1);

    await timers.fire(timers.pending[0]);

    expect(inserted).toHaveLength(1);
    expect(inserted[0].eventType === 'upsert' && inserted[0].state).toBe('exited');

    timers.restore();
  });
});

describe('ContainerInventoryCollector: init reconciliation', () => {
  let abortController: AbortController;
  let timers: TimerMock;

  beforeEach(() => {
    abortController = new AbortController();
    timers = mockSetTimeout({ fireImmediately: true });
  });

  afterEach(() => {
    timers.restore();
    abortController.abort();
  });

  it('init snapshot hydrates cache and writes upserts for changed containers', async () => {
    const snapshot = [makeRow({ containerId: 'abc123', state: 'running', eventType: 'upsert' })];
    const { repo, inserted } = createMockRepo(snapshot);
    const initEvent = { op: 'init', containers: [makeContainer({ state: 'exited' })] };
    const streamConnector = fixedStream([initEvent]);

    const collector = new ContainerInventoryCollector(HOST, async () => 'tok', repo, abortController, streamConnector);
    await (collector as any).hydrateCache();
    await (collector as any).collect();

    expect(inserted).toHaveLength(1);
    expect(inserted[0].eventType === 'upsert' && inserted[0].state).toBe('exited');
    expect(inserted[0].eventType).toBe('upsert');
  });

  it('init writes destroy for containers missing from snapshot (went offline)', async () => {
    const snapshot = [makeRow({ containerId: 'abc123', state: 'running', eventType: 'upsert' })];
    const { repo, inserted } = createMockRepo(snapshot);
    const initEvent = { op: 'init', containers: [] };
    const streamConnector = fixedStream([initEvent]);

    const collector = new ContainerInventoryCollector(HOST, async () => 'tok', repo, abortController, streamConnector);
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
    const streamConnector = fixedStream([initEvent]);

    const collector = new ContainerInventoryCollector(HOST, async () => 'tok', repo, abortController, streamConnector);
    await (collector as any).hydrateCache();
    await (collector as any).collect();

    expect(inserted).toHaveLength(0);
  });

  it('init does not write destroy for containers already marked destroy in cache', async () => {
    const snapshot = [makeRow({ containerId: 'abc123', eventType: 'destroy' })];
    const { repo, inserted } = createMockRepo(snapshot);
    const initEvent = { op: 'init', containers: [] };
    const streamConnector = fixedStream([initEvent]);

    const collector = new ContainerInventoryCollector(HOST, async () => 'tok', repo, abortController, streamConnector);
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

    const collector = new ContainerInventoryCollector(HOST, async () => 'tok', repo, abortController);
    await (collector as any).hydrateCache();

    const cache: Map<string, unknown> = (collector as any).stateCache;
    expect(cache.has('abc123')).toBe(true);
    expect(cache.has('def456')).toBe(false);
  });
});

describe('ContainerInventoryCollector: reconnection and abort', () => {
  let abortController: AbortController;

  beforeEach(() => {
    abortController = new AbortController();
  });

  afterEach(() => {
    abortController.abort();
  });

  it('reconnects after SSE error with exponential backoff', async () => {
    let callCount = 0;
    const timers = mockSetTimeout({ fireImmediately: true });

    const { repo } = createMockRepo();
    const streamConnector: StreamConnector = async () => {
      callCount++;
      if (callCount === 1) {
        return (async function* () {
          throw new Error('Connection reset');
        })();
      }
      abortController.abort();
      return (async function* () {})();
    };

    const collector = new ContainerInventoryCollector(HOST, async () => 'tok', repo, abortController, streamConnector);
    await collector.run();

    expect(callCount).toBeGreaterThanOrEqual(2);
    timers.restore();
  });

  it('stops cleanly when abort signal fires', async () => {
    const { repo } = createMockRepo();
    const streamConnector: StreamConnector = async () => {
      abortController.abort();
      return neverEndingStream([])({ agentUrl: '', path: '', signer: async () => '', signal: abortController.signal });
    };
    const connectSpy = mock(streamConnector);

    const collector = new ContainerInventoryCollector(HOST, async () => 'tok', repo, abortController, connectSpy as unknown as StreamConnector);
    await collector.run();

    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it('throws on a connect failure and triggers reconnect', async () => {
    let callCount = 0;
    const timers = mockSetTimeout({ fireImmediately: true });
    const { repo } = createMockRepo();
    const streamConnector: StreamConnector = async () => {
      callCount++;
      if (callCount <= 2) {
        throw new Error('Agent homeserver returned 404');
      }
      abortController.abort();
      return (async function* () {})();
    };

    const collector = new ContainerInventoryCollector(HOST, async () => 'tok', repo, abortController, streamConnector);
    await collector.run();

    expect(callCount).toBeGreaterThanOrEqual(3);
    timers.restore();
  });

  it('abort before run starts causes immediate exit', async () => {
    const controller = new AbortController();
    controller.abort();
    const { repo } = createMockRepo();
    const streamConnector = mock(fixedStream([]));

    const collector = new ContainerInventoryCollector(HOST, async () => 'tok', repo, controller, streamConnector as unknown as StreamConnector);
    await collector.run();

    expect(streamConnector).not.toHaveBeenCalled();
  });

  it('asyncDispose aborts the collector', async () => {
    const { repo } = createMockRepo();
    const collector = new ContainerInventoryCollector(HOST, async () => 'tok', repo, abortController);
    expect(collector.signal.aborted).toBe(false);

    await collector[Symbol.asyncDispose]();

    expect(collector.signal.aborted).toBe(true);
  });

  it('connects with the configured agent URL, path, and signer', async () => {
    const { repo } = createMockRepo();
    const streamConnector: StreamConnector = async () => {
      abortController.abort();
      return (async function* () {})();
    };
    const connectSpy = mock(streamConnector);

    const collector = new ContainerInventoryCollector(
      HOST, async () => 'secret-token', repo, abortController, connectSpy as unknown as StreamConnector,
    );
    await (collector as any).collect();

    const callArgs = connectSpy.mock.calls[0][0] as { agentUrl: string; path: string; signer: () => Promise<string> };
    expect(callArgs.agentUrl).toBe('http://192.168.1.10:9090');
    expect(callArgs.path).toBe('/containers/events');
    expect(await callArgs.signer()).toBe('secret-token');
  });

  it('drops SSE frames failing schema validation and continues', async () => {
    const timers = mockSetTimeout({ fireImmediately: true });

    const { repo, inserted } = createMockRepo();
    const streamConnector = fixedStream([
      { not: 'a valid event' },
      { op: 'upsert', container: makeContainer() },
    ]);

    const collector = new ContainerInventoryCollector(HOST, async () => 'tok', repo, abortController, streamConnector);
    await (collector as any).collect();

    expect(inserted).toHaveLength(1);
    timers.restore();
  });
});

describe('ContainerInventoryCollector: reconcileInit clears pending writes (Fix 6)', () => {
  let abortController: AbortController;

  beforeEach(() => {
    abortController = new AbortController();
  });

  afterEach(() => {
    abortController.abort();
  });

  it('purges pending flap-window writes when collect() errors and triggers reconnect', async () => {
    // Fire ≥500ms backoff timers so run() progresses; leave 250ms flap-window
    // timers captured but unfired so we can assert they get cleared.
    const timers: TimerMock = mockSetTimeout({
      onSchedule: (timer) => {
        if (timer.delayMs >= 500) queueMicrotask(() => timers.fire(timer));
      },
    });

    const snapshot = [makeRow({ containerId: 'abc123', state: 'running', eventType: 'upsert' })];
    const { repo, inserted } = createMockRepo(snapshot);

    let callCount = 0;
    const streamConnector: StreamConnector = async () => {
      callCount++;
      if (callCount === 1) {
        const upsertEvent = {
          op: 'upsert',
          container: makeContainer({ state: 'exited', exitCode: 0, finishedAt: '2026-04-16T10:01:00Z' }),
        };
        return (async function* () {
          yield upsertEvent;
          // Let the collector process the event and schedule the flap-window
          // write before we error the stream.
          await Promise.resolve();
          await Promise.resolve();
          throw new Error('stream broke');
        })();
      }
      abortController.abort();
      return (async function* () {})();
    };

    const collector = new ContainerInventoryCollector(HOST, async () => 'tok', repo, abortController, streamConnector);
    await collector.run();

    const flapTimers = timers.pending.filter((t) => t.delayMs === 250);
    expect(flapTimers).toHaveLength(0);
    expect(timers.clearSpy.mock.calls.length).toBeGreaterThan(0);

    const pendingWrites: Map<string, unknown> = (collector as any).pendingWrites;
    expect(pendingWrites.size).toBe(0);

    expect(inserted).toHaveLength(0);

    timers.restore();
  });

  it('reconcileInit cancels stale pending timers before processing the new snapshot', async () => {
    const timers = mockSetTimeout();

    const { repo, inserted } = createMockRepo();
    const collector = new ContainerInventoryCollector(HOST, async () => 'tok', repo, abortController);

    // Schedule a write that should be cancelled by reconcileInit
    (collector as any).scheduleWrite(makeContainer({ state: 'running' }), 'upsert');
    expect(timers.pending).toHaveLength(1);

    // reconcileInit should cancel pending timers before processing
    await (collector as any).reconcileInit([]);

    // The pending timer should have been cancelled
    expect(timers.pending).toHaveLength(0);
    // No writes should have happened from the cancelled timer
    expect(inserted).toHaveLength(0);

    timers.restore();
  });
});

describe('ContainerInventoryCollector: DB-write failure triggers reconnect', () => {
  let abortController: AbortController;

  beforeEach(() => {
    abortController = new AbortController();
  });

  afterEach(() => {
    abortController.abort();
  });

  it('DB insert rejection logs reconnect-intent message, aborts the current cycle controller, and purges pending writes', async () => {
    const timers = mockSetTimeout();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const snapshot = [makeRow({ containerId: 'abc123', state: 'running', eventType: 'upsert' })];
    const insertError = new Error('DB unavailable');
    const repo = {
      insert: mock(async () => { throw insertError; }),
      getCurrentSnapshot: mock(async () => snapshot),
    } as unknown as DockerContainerEventRepository;

    const collector = new ContainerInventoryCollector(HOST, async () => 'tok', repo, abortController);
    await (collector as any).hydrateCache();

    const cycleAbort = new AbortController();
    (collector as any).collectAbort = cycleAbort;

    (collector as any).scheduleWrite(makeContainer({ state: 'exited', exitCode: 1 }), 'upsert');
    (collector as any).scheduleWrite(makeContainer({ id: 'other', state: 'exited' }), 'upsert');

    const flapTimers = timers.pending.filter((t) => t.delayMs === 250);
    expect(flapTimers.length).toBeGreaterThanOrEqual(2);
    const firstTimer = flapTimers[0];

    timers.fire(firstTimer);
    await Promise.resolve();
    await Promise.resolve();

    const reconnectLog = errorSpy.mock.calls.find((args) =>
      args.some((a) => typeof a === 'string' && a.includes('triggering reconnect to resync'))
    );
    expect(reconnectLog).toBeDefined();

    expect(cycleAbort.signal.aborted).toBe(true);

    const pending: Map<string, unknown> = (collector as any).pendingWrites;
    expect(pending.size).toBe(0);

    // Failed write must not poison the cache; reconcileInit needs the pre-failure state.
    const cache: Map<string, { state: string | null }> = (collector as any).stateCache;
    expect(cache.get('abc123')?.state).toBe('running');

    timers.restore();
    errorSpy.mockRestore();
  });

  it('after DB-write failure, run() reconnects and reconcileInit resyncs state from the new snapshot', async () => {
    const timers = mockSetTimeout({ fireImmediately: true });
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const snapshot = [makeRow({ containerId: 'abc123', state: 'running', eventType: 'upsert' })];

    let insertCallCount = 0;
    const inserted: NewContainerEvent[] = [];
    const repo = {
      insert: mock(async (event: NewContainerEvent) => {
        insertCallCount++;
        if (insertCallCount === 1) {
          throw new Error('transient DB failure');
        }
        inserted.push(event);
        if (event.eventType === 'upsert' && event.state === 'exited' && event.containerId === 'abc123') {
          abortController.abort();
        }
        if (event.eventType === 'destroy') {
          return makeRow({ eventType: 'destroy', containerId: event.containerId });
        }
        return makeRow({ eventType: 'upsert', state: event.state, containerId: event.containerId });
      }),
      getCurrentSnapshot: mock(async () => snapshot),
    } as unknown as DockerContainerEventRepository;

    let fetchCallCount = 0;
    const streamConnector: StreamConnector = async () => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        return fixedStream([{ op: 'upsert', container: makeContainer({ state: 'exited', exitCode: 0 }) }])(
          { agentUrl: '', path: '', signer: async () => '', signal: abortController.signal },
        );
      }
      return fixedStream([{ op: 'init', containers: [makeContainer({ state: 'exited', exitCode: 0 })] }])(
        { agentUrl: '', path: '', signer: async () => '', signal: abortController.signal },
      );
    };

    const collector = new ContainerInventoryCollector(HOST, async () => 'tok', repo, abortController, streamConnector);
    await collector.run();

    expect(fetchCallCount).toBeGreaterThanOrEqual(2);

    expect(
      inserted.some((e) => e.eventType === 'upsert' && e.state === 'exited' && e.containerId === 'abc123'),
    ).toBe(true);

    const reconnectLog = errorSpy.mock.calls.find((args) =>
      args.some((a) => typeof a === 'string' && a.includes('triggering reconnect to resync'))
    );
    expect(reconnectLog).toBeDefined();

    timers.restore();
    errorSpy.mockRestore();
  });

  it('DB-write failure from a destroy timer also triggers reconnect', async () => {
    const timers = mockSetTimeout();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const repo = {
      insert: mock(async () => { throw new Error('DB down'); }),
      getCurrentSnapshot: mock(async () => []),
    } as unknown as DockerContainerEventRepository;

    const collector = new ContainerInventoryCollector(HOST, async () => 'tok', repo, abortController);
    const cycleAbort = new AbortController();
    (collector as any).collectAbort = cycleAbort;

    (collector as any).scheduleDestroyWrite('abc123');
    const destroyTimer = timers.scheduled[timers.scheduled.length - 1];
    expect(destroyTimer).toBeDefined();

    timers.fire(destroyTimer);
    await Promise.resolve();
    await Promise.resolve();

    const reconnectLog = errorSpy.mock.calls.find((args) =>
      args.some((a) => typeof a === 'string' && a.includes('DB destroy-write failed') && a.includes('triggering reconnect'))
    );
    expect(reconnectLog).toBeDefined();

    expect(cycleAbort.signal.aborted).toBe(true);

    const pending: Map<string, unknown> = (collector as any).pendingWrites;
    expect(pending.size).toBe(0);

    timers.restore();
    errorSpy.mockRestore();
  });
});

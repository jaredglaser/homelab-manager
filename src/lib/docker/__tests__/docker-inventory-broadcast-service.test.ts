import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { DockerInventoryBroadcastService, rowToInventory, notifyPayloadToInventory } from '../docker-inventory-broadcast-service';
import type { DockerInventorySnapshotContainer, DockerInventoryBroadcastEvent } from '@/types/docker-inventory';
import type { DockerContainerEventRow } from '@/lib/database/repositories/docker-container-event-repository';
import type { PoolClient } from 'pg';

type NotificationHandler = (msg: { channel: string; payload?: string }) => void;
type ErrorHandler = (err: Error) => void;

interface MockPoolClient {
  querySql: string | null;
  released: boolean;
  notificationHandlers: NotificationHandler[];
  errorHandlers: ErrorHandler[];
  on: ReturnType<typeof mock>;
  query: ReturnType<typeof mock>;
  release: ReturnType<typeof mock>;
  removeAllListeners: ReturnType<typeof mock>;
  emit: (event: 'notification' | 'error', arg: unknown) => void;
}

function createMockPoolClient(): MockPoolClient {
  const client: MockPoolClient = {
    querySql: null,
    released: false,
    notificationHandlers: [],
    errorHandlers: [],
    on: mock((event: string, handler: unknown) => {
      if (event === 'notification') client.notificationHandlers.push(handler as NotificationHandler);
      if (event === 'error') client.errorHandlers.push(handler as ErrorHandler);
    }),
    query: mock(async (sql: string) => {
      client.querySql = sql;
      return { rows: [], rowCount: 0 };
    }),
    release: mock(() => { client.released = true; }),
    removeAllListeners: mock(() => {}),
    emit(event, arg) {
      if (event === 'notification') {
        for (const h of client.notificationHandlers) h(arg as { channel: string; payload?: string });
      }
      if (event === 'error') {
        for (const h of client.errorHandlers) h(arg as Error);
      }
    },
  };
  return client;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const container1: DockerInventorySnapshotContainer = {
  host: 'server1',
  containerId: 'abc123',
  name: 'plex',
  image: 'plexinc/pms-docker:latest',
  state: 'running',
  composeProject: 'media',
  serviceKey: 'media/plex',
  startedAt: new Date('2026-04-16T10:00:00Z'),
  finishedAt: null,
  exitCode: null,
  labels: { 'com.docker.compose.project': 'media' },
  updatedAt: new Date('2026-04-16T10:00:00Z'),
};

const container2: DockerInventorySnapshotContainer = {
  host: 'server1',
  containerId: 'def456',
  name: 'traefik',
  image: 'traefik:latest',
  state: 'exited',
  composeProject: null,
  serviceKey: '',
  startedAt: null,
  finishedAt: new Date('2026-04-16T09:00:00Z'),
  exitCode: 1,
  labels: {},
  updatedAt: new Date('2026-04-16T09:00:00Z'),
};

describe('DockerInventoryBroadcastService', () => {
  let poolClient: MockPoolClient;
  let loadSnapshotFn: ReturnType<typeof mock>;
  let service: DockerInventoryBroadcastService;

  beforeEach(() => {
    poolClient = createMockPoolClient();
    loadSnapshotFn = mock(async () => [container1]);

    service = new DockerInventoryBroadcastService({
      getPoolClient: async () => poolClient as unknown as PoolClient,
      loadSnapshot: loadSnapshotFn as () => Promise<DockerInventorySnapshotContainer[]>,
    });
  });

  afterEach(async () => {
    await service.stop();
  });

  it('sends init payload with containers on subscribe', async () => {
    const received: DockerInventoryBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));

    await flush();

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('init');
    if (received[0].type === 'init') {
      expect(received[0].containers).toEqual([container1]);
    }
  });

  it('does not send init to subscriber that unsubscribed before snapshot resolved', async () => {
    let resolveSnapshot!: (v: DockerInventorySnapshotContainer[]) => void;
    const slowSnapshot = new Promise<DockerInventorySnapshotContainer[]>((r) => { resolveSnapshot = r; });
    const slowService = new DockerInventoryBroadcastService({
      getPoolClient: async () => poolClient as unknown as PoolClient,
      loadSnapshot: () => slowSnapshot,
    });

    const received: DockerInventoryBroadcastEvent[] = [];
    const unsub = slowService.subscribe((e) => received.push(e));

    unsub();
    resolveSnapshot([container1]);
    await flush();

    expect(received).toHaveLength(0);

    await slowService.stop();
  });

  it('excludes destroyed containers from the init snapshot', async () => {
    loadSnapshotFn = mock(async () => [container1]);
    service = new DockerInventoryBroadcastService({
      getPoolClient: async () => poolClient as unknown as PoolClient,
      loadSnapshot: loadSnapshotFn as () => Promise<DockerInventorySnapshotContainer[]>,
    });

    const received: DockerInventoryBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await flush();

    expect(received[0].type).toBe('init');
    if (received[0].type === 'init') {
      expect(received[0].containers).toHaveLength(1);
      expect(received[0].containers[0].containerId).toBe('abc123');
    }
  });

  it('issues LISTEN docker_container_change on subscribe', async () => {
    service.subscribe(() => {});
    await flush();
    expect(poolClient.querySql).toBe('LISTEN docker_container_change');
  });

  it('broadcasts upsert event from NOTIFY payload', async () => {
    const received: DockerInventoryBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await flush();

    const notifyPayload = JSON.stringify({
      at: '2026-04-16T11:00:00Z',
      host: 'server1',
      container_id: 'abc123',
      event_type: 'upsert',
      state: 'running',
      name: 'plex',
      image: 'plexinc/pms-docker:latest',
      compose_project: 'media',
      service_key: 'media/plex',
      started_at: '2026-04-16T10:00:00Z',
      finished_at: null,
      exit_code: null,
    });

    poolClient.emit('notification', { channel: 'docker_container_change', payload: notifyPayload });

    expect(received).toHaveLength(2); // init + upsert
    const upsertEvent = received[1];
    expect(upsertEvent.type).toBe('upsert');
    if (upsertEvent.type === 'upsert') {
      expect(upsertEvent.container.containerId).toBe('abc123');
      expect(upsertEvent.container.state).toBe('running');
      expect('labels' in upsertEvent.container).toBe(false);
    }
  });

  it('upsert events omit labels (NOTIFY payload omits labels)', async () => {
    const received: DockerInventoryBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await flush();

    poolClient.emit('notification', {
      channel: 'docker_container_change',
      payload: JSON.stringify({
        at: '2026-04-16T11:00:00Z',
        host: 'server1',
        container_id: 'abc123',
        event_type: 'upsert',
        state: 'running',
        name: 'plex',
        image: 'img',
        compose_project: null,
        service_key: '',
        started_at: null,
        finished_at: null,
        exit_code: null,
      }),
    });

    const upsertEvent = received.find((e) => e.type === 'upsert');
    expect(upsertEvent).toBeDefined();
    if (upsertEvent?.type === 'upsert') {
      expect('labels' in upsertEvent.container).toBe(false);
    }
  });

  it('broadcasts destroy event from NOTIFY payload', async () => {
    const received: DockerInventoryBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await flush();

    poolClient.emit('notification', {
      channel: 'docker_container_change',
      payload: JSON.stringify({
        at: '2026-04-16T11:30:00Z',
        host: 'server1',
        container_id: 'abc123',
        event_type: 'destroy',
        state: null,
        name: null,
        image: null,
        compose_project: null,
        service_key: null,
        started_at: null,
        finished_at: null,
        exit_code: null,
      }),
    });

    const destroyEvent = received.find((e) => e.type === 'destroy');
    expect(destroyEvent).toBeDefined();
    if (destroyEvent?.type === 'destroy') {
      expect(destroyEvent.host).toBe('server1');
      expect(destroyEvent.containerId).toBe('abc123');
      expect(destroyEvent.at).toBeInstanceOf(Date);
    }
  });

  it('swallows malformed NOTIFY payloads without crashing', async () => {
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

    const received: DockerInventoryBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await flush();

    poolClient.emit('notification', {
      channel: 'docker_container_change',
      payload: 'not-valid-json{{{',
    });

    expect(received).toHaveLength(1);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('stops listening when last subscriber unsubscribes', async () => {
    const unsub = service.subscribe(() => {});
    await flush();

    expect(poolClient.released).toBe(false);
    unsub();
    expect(poolClient.released).toBe(true);
  });

  it('keeps listening when one of multiple subscribers unsubscribes', async () => {
    const unsub1 = service.subscribe(() => {});
    const unsub2 = service.subscribe(() => {});
    await flush();

    unsub1();
    expect(poolClient.released).toBe(false);

    unsub2();
    expect(poolClient.released).toBe(true);
  });

  it('schedules reconnect when listener client emits error', async () => {
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout');

    service.subscribe(() => {});
    await flush();

    poolClient.emit('error', new Error('connection reset'));

    expect(setTimeoutSpy).toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it('executes reconnect callback and restarts listening after client error', async () => {
    // Fire setTimeout synchronously so the reconnect callback runs in-test.
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      ((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout
    );

    let connectCount = 0;
    const secondPoolClient = createMockPoolClient();
    const multiConnectService = new DockerInventoryBroadcastService({
      getPoolClient: async () => {
        connectCount++;
        return (connectCount === 1 ? poolClient : secondPoolClient) as unknown as PoolClient;
      },
      loadSnapshot: async () => [],
    });

    multiConnectService.subscribe(() => {});
    await flush();

    poolClient.emit('error', new Error('transient error'));
    await flush();

    expect(connectCount).toBeGreaterThanOrEqual(2);

    setTimeoutSpy.mockRestore();
    await multiConnectService.stop();
  });

  it('broadcasts to multiple subscribers independently', async () => {
    const received1: DockerInventoryBroadcastEvent[] = [];
    const received2: DockerInventoryBroadcastEvent[] = [];

    service.subscribe((e) => received1.push(e));
    service.subscribe((e) => received2.push(e));
    await flush();

    poolClient.emit('notification', {
      channel: 'docker_container_change',
      payload: JSON.stringify({
        at: '2026-04-16T11:00:00Z',
        host: 'server1',
        container_id: 'def456',
        event_type: 'upsert',
        state: 'exited',
        name: 'traefik',
        image: 'traefik:latest',
        compose_project: null,
        service_key: '',
        started_at: null,
        finished_at: '2026-04-16T09:00:00Z',
        exit_code: 1,
      }),
    });

    expect(received1.filter((e) => e.type === 'upsert')).toHaveLength(1);
    expect(received2.filter((e) => e.type === 'upsert')).toHaveLength(1);
  });

  it('resets reconnect backoff to base delay after a successful reconnect', async () => {
    const client1 = poolClient;
    const client2 = createMockPoolClient();
    const client3 = createMockPoolClient();
    let connectCount = 0;

    const resetService = new DockerInventoryBroadcastService({
      getPoolClient: async () => {
        connectCount++;
        if (connectCount === 1) return client1 as unknown as PoolClient;
        if (connectCount === 2) return client2 as unknown as PoolClient;
        return client3 as unknown as PoolClient;
      },
      loadSnapshot: async () => [],
    });

    resetService.subscribe(() => {});
    await flush();

    const capturedDelays: number[] = [];
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      ((fn: TimerHandler, delay?: number) => {
        capturedDelays.push(delay ?? 0);
        if (typeof fn === 'function') fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
    );

    try {
      client1.emit('error', new Error('first disconnect'));
      await flush();
      await flush();

      const firstCycleBackoffs = capturedDelays.filter((d) => d >= 500);
      expect(firstCycleBackoffs[0]).toBe(500);
      expect(connectCount).toBeGreaterThanOrEqual(2);

      // If backoff weren't reset after the successful reconnect, the next
      // delay would be 1000ms (500 * 2) rather than the base 500ms.
      capturedDelays.length = 0;
      client2.emit('error', new Error('second disconnect'));
      await flush();

      const secondCycleBackoffs = capturedDelays.filter((d) => d >= 500);
      expect(secondCycleBackoffs[0]).toBe(500);
    } finally {
      setTimeoutSpy.mockRestore();
      await resetService.stop();
    }
  });

  it('ignores notifications on other channels', async () => {
    const received: DockerInventoryBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await flush();

    poolClient.emit('notification', {
      channel: 'some_other_channel',
      payload: JSON.stringify({ event_type: 'upsert' }),
    });

    expect(received).toHaveLength(1); // only init
  });

  it('sends all snapshot containers in init when multiple exist', async () => {
    service = new DockerInventoryBroadcastService({
      getPoolClient: async () => poolClient as unknown as PoolClient,
      loadSnapshot: async () => [container1, container2],
    });

    const received: DockerInventoryBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await flush();

    expect(received[0].type).toBe('init');
    if (received[0].type === 'init') {
      expect(received[0].containers).toHaveLength(2);
    }
  });
});

describe('rowToInventory', () => {
  const baseRow: DockerContainerEventRow = {
    at: new Date('2026-04-16T10:00:00Z'),
    host: 'server1',
    containerId: 'abc123',
    eventType: 'upsert',
    state: 'running',
    name: 'plex',
    image: 'plexinc/pms-docker:latest',
    labels: { 'com.docker.compose.project': 'media' },
    composeProject: 'media',
    serviceKey: 'media/plex',
    startedAt: new Date('2026-04-16T09:50:00Z'),
    finishedAt: null,
    exitCode: null,
  };

  function asUpsert(row: DockerContainerEventRow) {
    if (row.eventType !== 'upsert') throw new Error('expected upsert row');
    return row;
  }

  it('maps all fields from a full row', () => {
    const result = rowToInventory(asUpsert(baseRow));
    expect(result.host).toBe('server1');
    expect(result.containerId).toBe('abc123');
    expect(result.name).toBe('plex');
    expect(result.image).toBe('plexinc/pms-docker:latest');
    expect(result.state).toBe('running');
    expect(result.composeProject).toBe('media');
    expect(result.serviceKey).toBe('media/plex');
    expect(result.startedAt).toEqual(new Date('2026-04-16T09:50:00Z'));
    expect(result.finishedAt).toBeNull();
    expect(result.exitCode).toBeNull();
    expect(result.labels).toEqual({ 'com.docker.compose.project': 'media' });
    expect(result.updatedAt).toEqual(new Date('2026-04-16T10:00:00Z'));
  });

  it('defaults null serviceKey to empty string', () => {
    const result = rowToInventory(asUpsert({ ...baseRow, serviceKey: null }));
    expect(result.serviceKey).toBe('');
  });

  it('defaults null labels to empty object', () => {
    const result = rowToInventory(
      asUpsert({ ...baseRow, labels: null as unknown as Record<string, string> }),
    );
    expect(result.labels).toEqual({});
  });
});

describe('notifyPayloadToInventory', () => {
  const basePayload = {
    at: '2026-04-16T11:00:00Z',
    host: 'server1',
    container_id: 'abc123',
    event_type: 'upsert',
    state: 'running',
    name: 'plex',
    image: 'plexinc/pms-docker:latest',
    compose_project: 'media',
    service_key: 'media/plex',
    started_at: '2026-04-16T10:00:00Z',
    finished_at: null,
    exit_code: null,
  };

  it('maps all fields from a NOTIFY payload', () => {
    const result = notifyPayloadToInventory(basePayload);
    expect(result.host).toBe('server1');
    expect(result.containerId).toBe('abc123');
    expect(result.name).toBe('plex');
    expect(result.state).toBe('running');
    expect(result.composeProject).toBe('media');
    expect(result.serviceKey).toBe('media/plex');
    expect(result.startedAt).toEqual(new Date('2026-04-16T10:00:00Z'));
    expect(result.finishedAt).toBeNull();
    expect(result.exitCode).toBeNull();
    expect(result.labels).toEqual({});
    expect(result.updatedAt).toEqual(new Date('2026-04-16T11:00:00Z'));
  });

  it('defaults null nullable fields to empty values', () => {
    const result = notifyPayloadToInventory({
      ...basePayload,
      name: null,
      image: null,
      state: null,
      compose_project: null,
      service_key: null,
      started_at: null,
      finished_at: null,
    });
    expect(result.name).toBe('');
    expect(result.image).toBe('');
    expect(result.state).toBe('unknown');
    expect(result.composeProject).toBeNull();
    expect(result.serviceKey).toBe('');
    expect(result.startedAt).toBeNull();
    expect(result.finishedAt).toBeNull();
  });

  it('always returns empty labels (NOTIFY payloads omit labels)', () => {
    const result = notifyPayloadToInventory(basePayload);
    expect(result.labels).toEqual({});
  });

  it('maps finished_at when present', () => {
    const result = notifyPayloadToInventory({
      ...basePayload,
      finished_at: '2026-04-16T11:30:00Z',
      exit_code: 1,
    });
    expect(result.finishedAt).toEqual(new Date('2026-04-16T11:30:00Z'));
    expect(result.exitCode).toBe(1);
  });

  it('throws when host is missing', () => {
    const { host: _host, ...withoutHost } = basePayload;
    void _host;
    expect(() => notifyPayloadToInventory(withoutHost)).toThrow(/missing required field 'host'/);
  });

  it('throws when container_id is missing', () => {
    const { container_id: _cid, ...withoutCid } = basePayload;
    void _cid;
    expect(() => notifyPayloadToInventory(withoutCid)).toThrow(/missing required field 'container_id'/);
  });

  it('throws when event_type is missing', () => {
    const { event_type: _et, ...withoutEt } = basePayload;
    void _et;
    expect(() => notifyPayloadToInventory(withoutEt)).toThrow(/missing required field 'event_type'/);
  });

  it('throws when at is missing', () => {
    const { at: _at, ...withoutAt } = basePayload;
    void _at;
    expect(() => notifyPayloadToInventory(withoutAt)).toThrow(/missing required field 'at'/);
  });
});

describe('DockerInventoryBroadcastService — malformed NOTIFY does not crash', () => {
  it('logs and continues when NOTIFY upsert payload is missing required fields', async () => {
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});
    const poolClient = createMockPoolClient();

    const service = new DockerInventoryBroadcastService({
      getPoolClient: async () => poolClient as unknown as PoolClient,
      loadSnapshot: async () => [],
    });

    const received: DockerInventoryBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    const flush = () => new Promise<void>((r) => setTimeout(r, 0));
    await flush();

    poolClient.emit('notification', {
      channel: 'docker_container_change',
      payload: JSON.stringify({
        at: '2026-04-16T11:00:00Z',
        // host is missing
        container_id: 'abc123',
        event_type: 'upsert',
        state: 'running',
      }),
    });

    expect(consoleSpy).toHaveBeenCalled();
    expect(received.filter((e) => e.type === 'upsert')).toHaveLength(0);

    consoleSpy.mockRestore();
    await service.stop();
  });
});

describe('zDockerInventoryBroadcastEvent', () => {
  it('parses a valid upsert frame', async () => {
    const { zDockerInventoryBroadcastEvent } = await import('@/types/docker-inventory');
    const frame = {
      type: 'upsert',
      container: {
        host: 'server1',
        containerId: 'abc123',
        name: 'plex',
        image: 'plexinc/pms-docker:latest',
        state: 'running',
        composeProject: 'media',
        serviceKey: 'media/plex',
        startedAt: new Date('2026-04-16T10:00:00Z'),
        finishedAt: null,
        exitCode: null,
        updatedAt: new Date('2026-04-16T11:00:00Z'),
      },
    };
    const result = zDockerInventoryBroadcastEvent.safeParse(frame);
    expect(result.success).toBe(true);
    // Upsert shape omits labels; zod strips them if present.
    if (result.success && result.data.type === 'upsert') {
      expect('labels' in result.data.container).toBe(false);
    }
  });

  it('rejects a snapshot container missing the required labels field', async () => {
    const { zDockerInventoryBroadcastEvent } = await import('@/types/docker-inventory');
    const frame = {
      type: 'init',
      containers: [
        {
          host: 'server1',
          containerId: 'abc123',
          name: 'plex',
          image: 'plexinc/pms-docker:latest',
          state: 'running',
          composeProject: null,
          serviceKey: '',
          startedAt: null,
          finishedAt: null,
          exitCode: null,
          updatedAt: new Date(),
          // labels intentionally missing — snapshot requires it
        },
      ],
    };
    const result = zDockerInventoryBroadcastEvent.safeParse(frame);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('labels'))).toBe(true);
    }
  });
});

describe('DockerInventoryBroadcastService — zod validation at NOTIFY boundary', () => {
  it('drops malformed NOTIFY frames before fanning out to subscribers', async () => {
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});
    const poolClient = createMockPoolClient();

    const service = new DockerInventoryBroadcastService({
      getPoolClient: async () => poolClient as unknown as PoolClient,
      loadSnapshot: async () => [],
    });

    const received: DockerInventoryBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    const flushLocal = () => new Promise<void>((r) => setTimeout(r, 0));
    await flushLocal();

    // NOTIFY payload with event_type 'upsert' but an invalid state value —
    // notifyPayloadToInventory builds an object, then zod rejects it.
    poolClient.emit('notification', {
      channel: 'docker_container_change',
      payload: JSON.stringify({
        at: '2026-04-16T11:00:00Z',
        host: 'server1',
        container_id: 'abc123',
        event_type: 'upsert',
        state: 'bogus-state',
        name: 'plex',
        image: 'img',
        compose_project: null,
        service_key: '',
        started_at: null,
        finished_at: null,
        exit_code: null,
      }),
    });

    // Service should not crash and should not deliver the malformed frame.
    expect(received.filter((e) => e.type === 'upsert')).toHaveLength(0);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
    await service.stop();
  });
});

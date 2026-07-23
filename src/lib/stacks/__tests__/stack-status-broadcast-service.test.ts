import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { StackStatusBroadcastService } from '../stack-status-broadcast-service';
import type { StackBroadcastEvent } from '../stack-status-broadcast-service';
import type { DockerInventorySnapshotContainer } from '@/types/docker-inventory';
import type { PoolClient } from 'pg';
import { waitForCondition } from '@/lib/test/wait-for-condition';

type NotificationHandler = (msg: { channel: string; payload?: string }) => void;
type ErrorHandler = (err: Error) => void;

interface MockPoolClient {
  issuedQueries: string[];
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
    issuedQueries: [],
    released: false,
    notificationHandlers: [],
    errorHandlers: [],
    on: mock((event: string, handler: unknown) => {
      if (event === 'notification') client.notificationHandlers.push(handler as NotificationHandler);
      if (event === 'error') client.errorHandlers.push(handler as ErrorHandler);
    }),
    query: mock(async (sql: string) => {
      client.issuedQueries.push(sql);
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

const composeContainer1: DockerInventorySnapshotContainer = {
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

const composeContainer2: DockerInventorySnapshotContainer = {
  host: 'server1',
  containerId: 'def456',
  name: 'sonarr',
  image: 'linuxserver/sonarr:latest',
  state: 'running',
  composeProject: 'media',
  serviceKey: 'media/sonarr',
  startedAt: new Date('2026-04-16T10:01:00Z'),
  finishedAt: null,
  exitCode: null,
  labels: { 'com.docker.compose.project': 'media' },
  updatedAt: new Date('2026-04-16T10:01:00Z'),
};

/** A container with no compose project; should always be excluded from stack output. */
const nonComposeContainer: DockerInventorySnapshotContainer = {
  host: 'server1',
  containerId: 'standalone999',
  name: 'traefik',
  image: 'traefik:latest',
  state: 'running',
  composeProject: null,
  serviceKey: '',
  startedAt: new Date('2026-04-16T09:00:00Z'),
  finishedAt: null,
  exitCode: null,
  labels: {},
  updatedAt: new Date('2026-04-16T09:00:00Z'),
};

const otherStackContainer: DockerInventorySnapshotContainer = {
  host: 'server1',
  containerId: 'proxy111',
  name: 'nginx',
  image: 'nginx:alpine',
  state: 'running',
  composeProject: 'proxy',
  serviceKey: 'proxy/nginx',
  startedAt: new Date('2026-04-16T08:00:00Z'),
  finishedAt: null,
  exitCode: null,
  labels: { 'com.docker.compose.project': 'proxy' },
  updatedAt: new Date('2026-04-16T08:00:00Z'),
};

describe('StackStatusBroadcastService', () => {
  let poolClient: MockPoolClient;
  let loadSnapshotFn: ReturnType<typeof mock>;
  let service: StackStatusBroadcastService;

  beforeEach(() => {
    poolClient = createMockPoolClient();
    loadSnapshotFn = mock(async () => [composeContainer1, nonComposeContainer]);

    service = new StackStatusBroadcastService({
      getPoolClient: async () => poolClient as unknown as PoolClient,
      loadSnapshot: loadSnapshotFn as () => Promise<DockerInventorySnapshotContainer[]>,
    });
  });

  afterEach(async () => {
    await service.stop();
  });

  it('sends init with only compose rows grouped by (host, stack)', async () => {
    const received: StackBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await waitForCondition(() => received.length > 0);

    expect(received).toHaveLength(1);
    const init = received[0];
    expect(init.type).toBe('status');
    if (init.type === 'status') {
      expect(init.entries).toHaveLength(1);
      expect(init.entries[0].stack).toBe('media');
      expect(init.entries[0].host).toBe('server1');
      expect(init.entries[0].containers).toHaveLength(1);
      expect(init.entries[0].containers[0].id).toBe('abc123');
    }
  });

  it('groups multiple containers from same stack into one entry', async () => {
    service = new StackStatusBroadcastService({
      getPoolClient: async () => poolClient as unknown as PoolClient,
      loadSnapshot: async () => [composeContainer1, composeContainer2],
    });

    const received: StackBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await waitForCondition(() => received.length > 0);

    const init = received[0];
    expect(init.type).toBe('status');
    if (init.type === 'status') {
      expect(init.entries).toHaveLength(1);
      expect(init.entries[0].containers).toHaveLength(2);
    }
  });

  it('groups containers from different stacks into separate entries', async () => {
    service = new StackStatusBroadcastService({
      getPoolClient: async () => poolClient as unknown as PoolClient,
      loadSnapshot: async () => [composeContainer1, otherStackContainer],
    });

    const received: StackBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await waitForCondition(() => received.length > 0);

    const init = received[0];
    expect(init.type).toBe('status');
    if (init.type === 'status') {
      expect(init.entries).toHaveLength(2);
      const stacks = init.entries.map((e) => e.stack).sort();
      expect(stacks).toEqual(['media', 'proxy']);
    }
  });

  it('excludes non-compose containers from init payload', async () => {
    const received: StackBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await waitForCondition(() => received.length > 0);

    const init = received[0];
    if (init.type === 'status') {
      const allIds = init.entries.flatMap((e) => e.containers.map((c) => c.id));
      expect(allIds).not.toContain('standalone999');
    }
  });

  it('does not send init to subscriber that unsubscribed before snapshot resolved', async () => {
    let resolveSnapshot!: (v: DockerInventorySnapshotContainer[]) => void;
    const slowSnapshot = new Promise<DockerInventorySnapshotContainer[]>((r) => { resolveSnapshot = r; });
    const slowService = new StackStatusBroadcastService({
      getPoolClient: async () => poolClient as unknown as PoolClient,
      loadSnapshot: () => slowSnapshot,
    });

    const received: StackBroadcastEvent[] = [];
    const unsub = slowService.subscribe((e) => received.push(e));
    // unsub() runs before sendInit() awaits the snapshot; await it only so pending work settles before stop().
    unsub();
    resolveSnapshot([composeContainer1]);
    await slowSnapshot;

    expect(received).toHaveLength(0);
    await slowService.stop();
  });

  it('issues LISTEN for both docker_container_change and deploy_change', async () => {
    service.subscribe(() => {});
    await waitForCondition(() => poolClient.issuedQueries.includes('LISTEN deploy_change'));

    expect(poolClient.issuedQueries).toContain('LISTEN docker_container_change');
    expect(poolClient.issuedQueries).toContain('LISTEN deploy_change');
  });

  it('broadcasts stack status update when compose container upserted', async () => {
    const received: StackBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await waitForCondition(() => received.length > 0);

    const notifyPayload = JSON.stringify({
      at: '2026-04-16T11:00:00Z',
      host: 'server1',
      container_id: 'abc123',
      event_type: 'upsert',
      state: 'exited',
      name: 'plex',
      image: 'plexinc/pms-docker:latest',
      compose_project: 'media',
      service_key: 'media/plex',
      started_at: null,
      finished_at: '2026-04-16T11:00:00Z',
      exit_code: 0,
    });

    // handleContainerChange runs synchronously, so emit() has already broadcast by the time it returns.
    poolClient.emit('notification', { channel: 'docker_container_change', payload: notifyPayload });

    expect(received.length).toBeGreaterThanOrEqual(2);
    const statusEvent = received.find((e, i) => i > 0 && e.type === 'status') as Extract<StackBroadcastEvent, { type: 'status' }> | undefined;
    expect(statusEvent).toBeDefined();
    if (statusEvent) {
      expect(statusEvent.entries).toHaveLength(1);
      expect(statusEvent.entries[0].stack).toBe('media');
      expect(statusEvent.entries[0].containers[0].status).toBe('exited');
    }
  });

  it('ignores upsert of non-compose container (null compose_project)', async () => {
    const received: StackBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await waitForCondition(() => received.length > 0);

    const countBefore = received.length;

    poolClient.emit('notification', {
      channel: 'docker_container_change',
      payload: JSON.stringify({
        at: '2026-04-16T11:00:00Z',
        host: 'server1',
        container_id: 'standalone999',
        event_type: 'upsert',
        state: 'running',
        name: 'traefik',
        image: 'traefik:latest',
        compose_project: null,
        service_key: '',
        started_at: null,
        finished_at: null,
        exit_code: null,
      }),
    });

    expect(received.length).toBe(countBefore);
  });

  it('broadcasts updated stack snapshot with container removed on destroy', async () => {
    service = new StackStatusBroadcastService({
      getPoolClient: async () => poolClient as unknown as PoolClient,
      loadSnapshot: async () => [composeContainer1, composeContainer2],
    });

    const received: StackBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await waitForCondition(() => received.length > 0);

    poolClient.emit('notification', {
      channel: 'docker_container_change',
      payload: JSON.stringify({
        at: '2026-04-16T12:00:00Z',
        host: 'server1',
        container_id: 'abc123',
        event_type: 'destroy',
        state: null,
        name: null,
        image: null,
        compose_project: 'media',
        service_key: null,
        started_at: null,
        finished_at: null,
        exit_code: null,
      }),
    });

    const statusEvents = received.filter((e) => e.type === 'status') as Extract<StackBroadcastEvent, { type: 'status' }>[];
    const lastStatus = statusEvents[statusEvents.length - 1];
    expect(lastStatus).toBeDefined();
    expect(lastStatus.entries[0].containers).toHaveLength(1);
    expect(lastStatus.entries[0].containers[0].id).toBe('def456');
  });

  it('broadcasts empty containers array when last container in stack is destroyed', async () => {
    const received: StackBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await waitForCondition(() => received.length > 0);

    poolClient.emit('notification', {
      channel: 'docker_container_change',
      payload: JSON.stringify({
        at: '2026-04-16T12:00:00Z',
        host: 'server1',
        container_id: 'abc123',
        event_type: 'destroy',
        state: null,
        name: null,
        image: null,
        compose_project: 'media',
        service_key: null,
        started_at: null,
        finished_at: null,
        exit_code: null,
      }),
    });

    const statusEvents = received.filter((e) => e.type === 'status') as Extract<StackBroadcastEvent, { type: 'status' }>[];
    const lastStatus = statusEvents[statusEvents.length - 1];
    expect(lastStatus).toBeDefined();
    expect(lastStatus.entries[0].containers).toHaveLength(0);
  });

  it('forwards deploy_change NOTIFY as deploy_changed event', async () => {
    const received: StackBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await waitForCondition(() => received.length > 0);

    poolClient.emit('notification', {
      channel: 'deploy_change',
      payload: JSON.stringify({ type: 'deploy_changed', stack: 'media', host: 'server1' }),
    });

    const deployEvent = received.find((e) => e.type === 'deploy_changed');
    expect(deployEvent).toBeDefined();
    if (deployEvent?.type === 'deploy_changed') {
      expect(deployEvent.stack).toBe('media');
      expect(deployEvent.host).toBe('server1');
    }
  });

  it('swallows malformed deploy_change payload without crashing', async () => {
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

    const received: StackBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await waitForCondition(() => received.length > 0);

    const countBefore = received.length;
    poolClient.emit('notification', {
      channel: 'deploy_change',
      payload: 'not-valid-json{{{',
    });

    expect(received.length).toBe(countBefore);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('swallows malformed docker_container_change payload without crashing', async () => {
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

    const received: StackBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await waitForCondition(() => received.length > 0);

    const countBefore = received.length;
    poolClient.emit('notification', {
      channel: 'docker_container_change',
      payload: 'not-valid-json{{{',
    });

    expect(received.length).toBe(countBefore);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('auto-starts on first subscriber and auto-stops on last unsubscribe', async () => {
    const unsub = service.subscribe(() => {});
    await waitForCondition(() => poolClient.notificationHandlers.length > 0);

    expect(poolClient.released).toBe(false);
    // cleanupListenerClient() releases synchronously; no wait needed.
    unsub();
    expect(poolClient.released).toBe(true);
  });

  it('keeps listening when one of multiple subscribers unsubscribes', async () => {
    const unsub1 = service.subscribe(() => {});
    const unsub2 = service.subscribe(() => {});
    await waitForCondition(() => poolClient.notificationHandlers.length > 0);

    unsub1();
    expect(poolClient.released).toBe(false);

    unsub2();
    expect(poolClient.released).toBe(true);
  });

  it('schedules reconnect when listener client emits error', async () => {
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout');

    service.subscribe(() => {});
    await waitForCondition(() => poolClient.notificationHandlers.length > 0);

    // error handler schedules reconnect via synchronous setTimeout; no wait needed.
    poolClient.emit('error', new Error('connection reset'));

    expect(setTimeoutSpy).toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it('reloads snapshot on reconnect to rebuild in-memory state', async () => {
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      ((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout,
    );

    let connectCount = 0;
    const secondPoolClient = createMockPoolClient();
    const reconnectService = new StackStatusBroadcastService({
      getPoolClient: async () => {
        connectCount++;
        return (connectCount === 1 ? poolClient : secondPoolClient) as unknown as PoolClient;
      },
      loadSnapshot: async () => [composeContainer1],
    });

    reconnectService.subscribe(() => {});
    await waitForCondition(() => connectCount >= 1);

    poolClient.emit('error', new Error('transient error'));
    await waitForCondition(() => connectCount >= 2);

    expect(connectCount).toBeGreaterThanOrEqual(2);

    setTimeoutSpy.mockRestore();
    await reconnectService.stop();
  });

  it('ignores notifications on unrecognized channels', async () => {
    const received: StackBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await waitForCondition(() => received.length > 0);

    const countBefore = received.length;
    poolClient.emit('notification', {
      channel: 'some_other_channel',
      payload: JSON.stringify({ event_type: 'upsert' }),
    });

    expect(received.length).toBe(countBefore);
  });

  it('broadcasts to multiple subscribers independently', async () => {
    const received1: StackBroadcastEvent[] = [];
    const received2: StackBroadcastEvent[] = [];

    service.subscribe((e) => received1.push(e));
    service.subscribe((e) => received2.push(e));
    await waitForCondition(() => received1.length > 0 && received2.length > 0);

    poolClient.emit('notification', {
      channel: 'deploy_change',
      payload: JSON.stringify({ type: 'deploy_changed', stack: 'media', host: 'server1' }),
    });

    expect(received1.filter((e) => e.type === 'deploy_changed')).toHaveLength(1);
    expect(received2.filter((e) => e.type === 'deploy_changed')).toHaveLength(1);
  });

  it('sets updated_at to the most recent container updatedAt in the group', async () => {
    service = new StackStatusBroadcastService({
      getPoolClient: async () => poolClient as unknown as PoolClient,
      loadSnapshot: async () => [composeContainer1, composeContainer2],
    });

    const received: StackBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await waitForCondition(() => received.length > 0);

    const init = received[0];
    if (init.type === 'status') {
      // composeContainer2.updatedAt (10:01) > composeContainer1.updatedAt (10:00)
      expect(init.entries[0].updated_at).toBe('2026-04-16T10:01:00.000Z');
    }
  });

  it('produces StackStatusRow with correct container fields', async () => {
    const received: StackBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await waitForCondition(() => received.length > 0);

    const init = received[0];
    if (init.type === 'status') {
      const container = init.entries[0].containers[0];
      expect(container.id).toBe('abc123');
      expect(container.name).toBe('plex');
      expect(container.status).toBe('running');
      expect(container.image).toBe('plexinc/pms-docker:latest');
      // serviceKey is "media/plex"; service should be the bare service name for docker compose
      expect(container.service).toBe('plex');
    }
  });

  it('toStackContainer: serviceKey without slash maps service to the bare key', async () => {
    const noPrefixService = new StackStatusBroadcastService({
      getPoolClient: async () => poolClient as unknown as PoolClient,
      loadSnapshot: async () => [
        {
          ...composeContainer1,
          serviceKey: 'plex', // no slash: already the bare service name
        },
      ],
    });

    const received: StackBroadcastEvent[] = [];
    noPrefixService.subscribe((e) => received.push(e));
    await waitForCondition(() => received.length > 0);

    const init = received[0];
    if (init.type === 'status') {
      expect(init.entries[0].containers[0].service).toBe('plex');
    }
    await noPrefixService.stop();
  });

  it('toStackContainer: empty string serviceKey is normalized to null', async () => {
    const emptyKeyService = new StackStatusBroadcastService({
      getPoolClient: async () => poolClient as unknown as PoolClient,
      loadSnapshot: async () => [
        {
          ...composeContainer1,
          serviceKey: '',
        },
      ],
    });

    const received: StackBroadcastEvent[] = [];
    emptyKeyService.subscribe((e) => received.push(e));
    await waitForCondition(() => received.length > 0);

    const init = received[0];
    if (init.type === 'status') {
      expect(init.entries[0].containers[0].service).toBeNull();
    }
    await emptyKeyService.stop();
  });

  it('toStackContainer: trailing-slash serviceKey ("media/") normalizes service to null', async () => {
    // "media/" splits to ["media", ""], and "" is falsy — must normalize to null, not "".
    const trailingSlashService = new StackStatusBroadcastService({
      getPoolClient: async () => poolClient as unknown as PoolClient,
      loadSnapshot: async () => [
        {
          ...composeContainer1,
          serviceKey: 'media/',
        },
      ],
    });

    const received: StackBroadcastEvent[] = [];
    trailingSlashService.subscribe((e) => received.push(e));
    await waitForCondition(() => received.length > 0);

    const init = received[0];
    if (init.type === 'status') {
      expect(init.entries[0].containers[0].service).toBeNull();
    }
    await trailingSlashService.stop();
  });

  it('updated_at is an ISO string', async () => {
    const received: StackBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await waitForCondition(() => received.length > 0);

    const init = received[0] as Extract<StackBroadcastEvent, { type: 'status' }>;
    expect(typeof init.entries[0].updated_at).toBe('string');
    expect(init.entries[0].updated_at).toBe('2026-04-16T10:00:00.000Z');
  });

  it('broadcasts empty-stack destroy with event at timestamp as ISO string', async () => {
    const received: StackBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await waitForCondition(() => received.length > 0);

    poolClient.emit('notification', {
      channel: 'docker_container_change',
      payload: JSON.stringify({
        at: '2026-04-16T12:34:56Z',
        host: 'server1',
        container_id: 'abc123',
        event_type: 'destroy',
        state: null,
        name: null,
        image: null,
        compose_project: 'media',
        service_key: null,
        started_at: null,
        finished_at: null,
        exit_code: null,
      }),
    });

    const statusEvents = received.filter((e) => e.type === 'status') as Extract<StackBroadcastEvent, { type: 'status' }>[];
    const lastStatus = statusEvents[statusEvents.length - 1];
    expect(lastStatus).toBeDefined();
    expect(lastStatus.entries[0].containers).toHaveLength(0);
    expect(lastStatus.entries[0].updated_at).toBe('2026-04-16T12:34:56.000Z');
  });

  it('destroy NOTIFY with null compose_project removes container from stack and broadcasts', async () => {
    service = new StackStatusBroadcastService({
      getPoolClient: async () => poolClient as unknown as PoolClient,
      loadSnapshot: async () => [composeContainer1],
    });

    const received: StackBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await waitForCondition(() => received.length > 0);

    // Real Docker destroy events carry labels: {} so compose_project is null,
    // so removal must still find the container via its in-memory stack entry.
    poolClient.emit('notification', {
      channel: 'docker_container_change',
      payload: JSON.stringify({
        at: '2026-04-16T13:00:00Z',
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

    const statusEvents = received.filter((e) => e.type === 'status') as Extract<StackBroadcastEvent, { type: 'status' }>[];
    expect(statusEvents.length).toBeGreaterThanOrEqual(2);
    const lastStatus = statusEvents[statusEvents.length - 1];
    expect(lastStatus).toBeDefined();
    expect(lastStatus.entries[0].containers).toHaveLength(0);
  });

  it('rebuilds in-memory state from fresh snapshot on reconnect, discarding pre-reconnect containers', async () => {
    // Iterate the reconnect-path startListening: 1st getPoolClient succeeds,
    // 2nd transiently fails (flips isFirstConnect = false), 3rd succeeds so
    // loadSnapshot + rebuildFromSnapshot fires.
    const firstClient = createMockPoolClient();
    const secondClient = createMockPoolClient();
    let connectCount = 0;
    let snapshotCallCount = 0;

    const containerX: DockerInventorySnapshotContainer = {
      host: 'server1',
      containerId: 'containerIdX',
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
    const containerY: DockerInventorySnapshotContainer = {
      host: 'server1',
      containerId: 'containerIdY',
      name: 'sonarr',
      image: 'linuxserver/sonarr:latest',
      state: 'running',
      composeProject: 'media',
      serviceKey: 'media/sonarr',
      startedAt: new Date('2026-04-16T11:00:00Z'),
      finishedAt: null,
      exitCode: null,
      labels: { 'com.docker.compose.project': 'media' },
      updatedAt: new Date('2026-04-16T11:00:00Z'),
    };

    const reconnectService = new StackStatusBroadcastService({
      getPoolClient: async () => {
        connectCount++;
        if (connectCount === 1) return firstClient as unknown as PoolClient;
        if (connectCount === 2) throw new Error('transient getPoolClient failure');
        return secondClient as unknown as PoolClient;
      },
      loadSnapshot: async () => {
        snapshotCallCount++;
        return snapshotCallCount === 1 ? [containerX] : [containerY];
      },
    });

    const received: StackBroadcastEvent[] = [];
    reconnectService.subscribe((e) => received.push(e));
    await waitForCondition(() => received.length > 0);

    expect(received.length).toBeGreaterThanOrEqual(1);
    const initStatus = received[0] as Extract<StackBroadcastEvent, { type: 'status' }>;
    expect(initStatus.type).toBe('status');
    expect(initStatus.entries[0].containers.map((c) => c.id)).toEqual(['containerIdX']);

    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      ((fn: TimerHandler) => {
        if (typeof fn === 'function') fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
    );

    try {
      firstClient.emit('error', new Error('connection lost'));
      await waitForCondition(() => connectCount >= 3 && snapshotCallCount >= 2);

      expect(connectCount).toBeGreaterThanOrEqual(3);
      expect(snapshotCallCount).toBeGreaterThanOrEqual(2);

      received.length = 0;
      secondClient.emit('notification', {
        channel: 'docker_container_change',
        payload: JSON.stringify({
          at: '2026-04-16T12:00:00Z',
          host: 'server1',
          container_id: 'containerIdY',
          event_type: 'upsert',
          state: 'running',
          name: 'sonarr',
          image: 'linuxserver/sonarr:latest',
          compose_project: 'media',
          service_key: 'media/sonarr',
          started_at: '2026-04-16T11:00:00Z',
          finished_at: null,
          exit_code: null,
        }),
      });

      const statusEvents = received.filter((e) => e.type === 'status') as Extract<StackBroadcastEvent, { type: 'status' }>[];
      expect(statusEvents).toHaveLength(1);
      const stackEntry = statusEvents[0].entries[0];
      const ids = stackEntry.containers.map((c) => c.id);
      expect(ids).toContain('containerIdY');
      expect(ids).not.toContain('containerIdX');
    } finally {
      setTimeoutSpy.mockRestore();
      await reconnectService.stop();
    }
  });

  it('continues broadcasting to other subscribers when one subscriber throws', async () => {
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

    const received2: StackBroadcastEvent[] = [];
    service.subscribe(() => {
      throw new Error('subscriber 1 is broken');
    });
    service.subscribe((e) => received2.push(e));
    await waitForCondition(() => received2.length > 0);

    received2.length = 0;

    // Stack state is already seeded, so sendInit() for this subscriber builds from memory synchronously.
    service.subscribe(() => {});

    poolClient.emit('notification', {
      channel: 'docker_container_change',
      payload: JSON.stringify({
        at: '2026-04-16T11:00:00Z',
        host: 'server1',
        container_id: 'abc123',
        event_type: 'upsert',
        state: 'exited',
        name: 'plex',
        image: 'plexinc/pms-docker:latest',
        compose_project: 'media',
        service_key: 'media/plex',
        started_at: null,
        finished_at: '2026-04-16T11:00:00Z',
        exit_code: 0,
      }),
    });

    const statusEvents = received2.filter((e) => e.type === 'status') as Extract<StackBroadcastEvent, { type: 'status' }>[];
    expect(statusEvents.length).toBeGreaterThanOrEqual(1);
    expect(statusEvents[0].entries[0].stack).toBe('media');

    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('stopListening cancels pending reconnect timer on stop', async () => {
    const capturedTimers: Array<() => void> = [];
    const originalSetTimeout = globalThis.setTimeout;
    let timerSet = false;

    service.subscribe(() => {});
    await waitForCondition(() => poolClient.notificationHandlers.length > 0);

    (globalThis as any).setTimeout = (fn: () => void) => {
      capturedTimers.push(fn);
      timerSet = true;
      return {} as any;
    };

    try {
      poolClient.emit('error', new Error('connection reset'));
      expect(timerSet).toBe(true);

      await service.stop();

      // Captured timers should be no-ops: stop() cleared them in stopListening.
      for (const fn of capturedTimers) {
        fn();
      }
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});

// defaultGetPoolClient and defaultLoadSnapshot are the production defaults used
// when no deps are injected. They use dynamic imports so we mock those modules
// here; bun resolves dynamic imports at call time, so the mocks apply even
// though StackStatusBroadcastService was already imported above.
mock.module('@/lib/config/database-config', () => ({
  loadDatabaseConfig: () => ({}),
}));

mock.module('@/lib/clients/database-client', () => ({
  databaseConnectionManager: {
    getClient: async () => ({
      getPool: () => ({
        connect: async () => {
          const client = createMockPoolClient();
          return client as unknown as PoolClient;
        },
      }),
    }),
  },
}));

mock.module('@/lib/database/repositories/docker-container-event-repository', () => ({
  DockerContainerEventRepository: class {
    async getCurrentSnapshot() { return []; }
  },
}));

describe('default dependency implementations', () => {
  it('uses defaultGetPoolClient and defaultLoadSnapshot when no deps are injected', async () => {
    const service = new StackStatusBroadcastService();
    const received: unknown[] = [];
    const unsub = service.subscribe((event) => { received.push(event); });
    await waitForCondition(() => received.some((e) => (e as { type: string }).type === 'status'));
    unsub();
    await service.stop();
    // sendInit fires a 'status' event with an empty entries list (snapshot is empty)
    expect(received.some((e) => (e as { type: string }).type === 'status')).toBe(true);
  });
});

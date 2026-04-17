import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { StackStatusBroadcastService } from '../stack-status-broadcast-service';
import type { StackBroadcastEvent } from '../stack-status-broadcast-service';
import type { DockerContainerInventory } from '@/types/docker-inventory';
import type { PoolClient } from 'pg';

// ---------------------------------------------------------------------------
// Mock pool client
// ---------------------------------------------------------------------------

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

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const composeContainer1: DockerContainerInventory = {
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

const composeContainer2: DockerContainerInventory = {
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

/** A container with no compose project — should always be excluded from stack output. */
const nonComposeContainer: DockerContainerInventory = {
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

const otherStackContainer: DockerContainerInventory = {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StackStatusBroadcastService', () => {
  let poolClient: MockPoolClient;
  let loadSnapshotFn: ReturnType<typeof mock>;
  let service: StackStatusBroadcastService;

  beforeEach(() => {
    poolClient = createMockPoolClient();
    loadSnapshotFn = mock(async () => [composeContainer1, nonComposeContainer]);

    service = new StackStatusBroadcastService({
      getPoolClient: async () => poolClient as unknown as PoolClient,
      loadSnapshot: loadSnapshotFn as () => Promise<DockerContainerInventory[]>,
    });
  });

  afterEach(async () => {
    await service.stop();
  });

  // -------------------------------------------------------------------------
  // Init on subscribe
  // -------------------------------------------------------------------------

  it('sends init with only compose rows grouped by (host, stack)', async () => {
    const received: StackBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await flush();

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
    await flush();

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
    await flush();

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
    await flush();

    const init = received[0];
    if (init.type === 'status') {
      const allIds = init.entries.flatMap((e) => e.containers.map((c) => c.id));
      expect(allIds).not.toContain('standalone999');
    }
  });

  it('does not send init to subscriber that unsubscribed before snapshot resolved', async () => {
    let resolveSnapshot!: (v: DockerContainerInventory[]) => void;
    const slowSnapshot = new Promise<DockerContainerInventory[]>((r) => { resolveSnapshot = r; });
    const slowService = new StackStatusBroadcastService({
      getPoolClient: async () => poolClient as unknown as PoolClient,
      loadSnapshot: () => slowSnapshot,
    });

    const received: StackBroadcastEvent[] = [];
    const unsub = slowService.subscribe((e) => received.push(e));
    unsub();
    resolveSnapshot([composeContainer1]);
    await flush();

    expect(received).toHaveLength(0);
    await slowService.stop();
  });

  // -------------------------------------------------------------------------
  // LISTEN channels
  // -------------------------------------------------------------------------

  it('issues LISTEN for both docker_container_change and deploy_change', async () => {
    service.subscribe(() => {});
    await flush();

    expect(poolClient.issuedQueries).toContain('LISTEN docker_container_change');
    expect(poolClient.issuedQueries).toContain('LISTEN deploy_change');
  });

  // -------------------------------------------------------------------------
  // docker_container_change → upsert with compose_project
  // -------------------------------------------------------------------------

  it('broadcasts stack status update when compose container upserted', async () => {
    const received: StackBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await flush();

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

    poolClient.emit('notification', { channel: 'docker_container_change', payload: notifyPayload });

    // init + the stack update
    expect(received.length).toBeGreaterThanOrEqual(2);
    const statusEvent = received.find((e, i) => i > 0 && e.type === 'status') as Extract<StackBroadcastEvent, { type: 'status' }> | undefined;
    expect(statusEvent).toBeDefined();
    if (statusEvent) {
      expect(statusEvent.entries).toHaveLength(1);
      expect(statusEvent.entries[0].stack).toBe('media');
      expect(statusEvent.entries[0].containers[0].status).toBe('exited');
    }
  });

  // -------------------------------------------------------------------------
  // docker_container_change → upsert with null compose_project (ignored)
  // -------------------------------------------------------------------------

  it('ignores upsert of non-compose container (null compose_project)', async () => {
    const received: StackBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await flush();

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

    // No additional broadcast for non-compose container
    expect(received.length).toBe(countBefore);
  });

  // -------------------------------------------------------------------------
  // docker_container_change → destroy
  // -------------------------------------------------------------------------

  it('broadcasts updated stack snapshot with container removed on destroy', async () => {
    service = new StackStatusBroadcastService({
      getPoolClient: async () => poolClient as unknown as PoolClient,
      loadSnapshot: async () => [composeContainer1, composeContainer2],
    });

    const received: StackBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await flush();

    // Destroy composeContainer1
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
    // Should have received an update
    const lastStatus = statusEvents[statusEvents.length - 1];
    expect(lastStatus).toBeDefined();
    // Only sonarr (def456) should remain
    expect(lastStatus.entries[0].containers).toHaveLength(1);
    expect(lastStatus.entries[0].containers[0].id).toBe('def456');
  });

  it('broadcasts empty containers array when last container in stack is destroyed', async () => {
    const received: StackBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await flush();

    // Destroy the only container in the 'media' stack
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

  // -------------------------------------------------------------------------
  // deploy_change → deploy_changed forwarded
  // -------------------------------------------------------------------------

  it('forwards deploy_change NOTIFY as deploy_changed event', async () => {
    const received: StackBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await flush();

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
    await flush();

    const countBefore = received.length;
    poolClient.emit('notification', {
      channel: 'deploy_change',
      payload: 'not-valid-json{{{',
    });

    expect(received.length).toBe(countBefore);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Malformed docker_container_change payload is swallowed
  // -------------------------------------------------------------------------

  it('swallows malformed docker_container_change payload without crashing', async () => {
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

    const received: StackBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await flush();

    const countBefore = received.length;
    poolClient.emit('notification', {
      channel: 'docker_container_change',
      payload: 'not-valid-json{{{',
    });

    expect(received.length).toBe(countBefore);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Auto-start / auto-stop
  // -------------------------------------------------------------------------

  it('auto-starts on first subscriber and auto-stops on last unsubscribe', async () => {
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

  // -------------------------------------------------------------------------
  // Reconnect
  // -------------------------------------------------------------------------

  it('schedules reconnect when listener client emits error', async () => {
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout');

    service.subscribe(() => {});
    await flush();

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
    await flush();

    poolClient.emit('error', new Error('transient error'));
    await flush();

    expect(connectCount).toBeGreaterThanOrEqual(2);

    setTimeoutSpy.mockRestore();
    await reconnectService.stop();
  });

  // -------------------------------------------------------------------------
  // Notifications on unrelated channels are ignored
  // -------------------------------------------------------------------------

  it('ignores notifications on unrecognized channels', async () => {
    const received: StackBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await flush();

    const countBefore = received.length;
    poolClient.emit('notification', {
      channel: 'some_other_channel',
      payload: JSON.stringify({ event_type: 'upsert' }),
    });

    expect(received.length).toBe(countBefore);
  });

  // -------------------------------------------------------------------------
  // Multiple subscribers receive the same event
  // -------------------------------------------------------------------------

  it('broadcasts to multiple subscribers independently', async () => {
    const received1: StackBroadcastEvent[] = [];
    const received2: StackBroadcastEvent[] = [];

    service.subscribe((e) => received1.push(e));
    service.subscribe((e) => received2.push(e));
    await flush();

    poolClient.emit('notification', {
      channel: 'deploy_change',
      payload: JSON.stringify({ type: 'deploy_changed', stack: 'media', host: 'server1' }),
    });

    expect(received1.filter((e) => e.type === 'deploy_changed')).toHaveLength(1);
    expect(received2.filter((e) => e.type === 'deploy_changed')).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // updated_at is the max across the group
  // -------------------------------------------------------------------------

  it('sets updated_at to the most recent container updatedAt in the group', async () => {
    service = new StackStatusBroadcastService({
      getPoolClient: async () => poolClient as unknown as PoolClient,
      loadSnapshot: async () => [composeContainer1, composeContainer2],
    });

    const received: StackBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await flush();

    const init = received[0];
    if (init.type === 'status') {
      // composeContainer2.updatedAt (10:01) > composeContainer1.updatedAt (10:00)
      expect(init.entries[0].updated_at).toBe('2026-04-16T10:01:00.000Z');
    }
  });

  // -------------------------------------------------------------------------
  // StackStatusRow shape
  // -------------------------------------------------------------------------

  it('produces StackStatusRow with correct container fields', async () => {
    const received: StackBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await flush();

    const init = received[0];
    if (init.type === 'status') {
      const container = init.entries[0].containers[0];
      expect(container.id).toBe('abc123');
      expect(container.name).toBe('plex');
      expect(container.status).toBe('running');
      expect(container.image).toBe('plexinc/pms-docker:latest');
    }
  });

  it('updated_at is an ISO string', async () => {
    const received: StackBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await flush();

    const init = received[0] as Extract<StackBroadcastEvent, { type: 'status' }>;
    expect(typeof init.entries[0].updated_at).toBe('string');
    expect(init.entries[0].updated_at).toBe('2026-04-16T10:00:00.000Z');
  });

  // -------------------------------------------------------------------------
  // Fix 4: empty-stack destroy uses event's at timestamp
  // -------------------------------------------------------------------------

  it('broadcasts empty-stack destroy with event at timestamp as ISO string', async () => {
    const received: StackBroadcastEvent[] = [];
    service.subscribe((e) => received.push(e));
    await flush();

    // Destroy the only container in the 'media' stack
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
});

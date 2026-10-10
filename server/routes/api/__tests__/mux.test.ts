import { describe, it, expect, mock, beforeEach, afterEach, beforeAll, spyOn } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { PoolClient } from 'pg';
import { mockModule } from '@/lib/test/mock-module';
import type { DockerInventorySnapshotContainer } from '@/types/docker-inventory';

const mockAuthenticate = mock(async () => ({ id: 'test-user' } as unknown));
const mockFindByName = mock(async (_: string) => null as null | { name: string; agentUrl: string });
const mockGetPrivateKeyForHost = mock(async (_: string) => null as null | object);

// Real server-init runs deploy recovery and DB shutdown hooks on import. Stub it to a no-op.
mock.module('@/lib/server-init', () => ({}));

class FakePoolClient extends EventEmitter {
  queries: string[] = [];
  released = false;
  async query(sql: string): Promise<unknown> {
    this.queries.push(sql);
    return {};
  }
  release(): void {
    this.released = true;
  }
}

function makePoolHarness() {
  const clients: FakePoolClient[] = [];
  return {
    clients,
    async getPoolClient(): Promise<PoolClient> {
      const client = new FakePoolClient();
      clients.push(client);
      return client as unknown as PoolClient;
    },
  };
}

const settingsHarness = makePoolHarness();
const stackHarness = makePoolHarness();
const settingsState = { all: new Map<string, string>(), values: new Map<string, string>() };
const stackState = { snapshot: [] as DockerInventorySnapshotContainer[] };

mockModule<typeof import('@/lib/settings/settings-broadcast-service')>(
  '@/lib/settings/settings-broadcast-service',
  (real) => ({
    ...real,
    settingsBroadcastService: new real.SettingsBroadcastService({
      getPoolClient: settingsHarness.getPoolClient,
      loadAllSettings: async () => new Map(settingsState.all),
      loadSingleSetting: async (key) => settingsState.values.get(key) ?? null,
    }),
  }),
);

mockModule<typeof import('@/lib/stacks/stack-status-broadcast-service')>(
  '@/lib/stacks/stack-status-broadcast-service',
  (real) => ({
    ...real,
    stackStatusBroadcastService: new real.StackStatusBroadcastService({
      getPoolClient: stackHarness.getPoolClient,
      loadSnapshot: async () => stackState.snapshot,
    }),
  }),
);

mockModule<typeof import('@/lib/auth/sse-auth')>('@/lib/auth/sse-auth', (real) => ({
  ...real,
  authenticateSSE: mockAuthenticate,
}));

mockModule<typeof import('@/lib/clients/database-client')>('@/lib/clients/database-client', (real) => ({
  ...real,
  databaseConnectionManager: {
    getClient: async () => ({ getPool: () => ({} as object) }),
  },
}));

mockModule<typeof import('@/lib/config/database-config')>('@/lib/config/database-config', (real) => ({
  ...real,
  loadDatabaseConfig: () => ({}),
}));

mockModule<typeof import('@/lib/database/repositories/host-repository')>('@/lib/database/repositories/host-repository', (real) => ({
  ...real,
  HostRepository: class {
    findByName = mockFindByName;
  },
}));

mockModule<typeof import('@/lib/database/repositories/agent-keypairs-repository')>('@/lib/database/repositories/agent-keypairs-repository', (real) => ({
  ...real,
  AgentKeypairsRepository: class {
    getPrivateKeyForHost = mockGetPrivateKeyForHost;
  },
}));

mockModule<typeof import('@/lib/crypto/master-key')>('@/lib/crypto/master-key', (real) => ({
  ...real,
  loadMasterKeyring: async () => ({}),
}));

mockModule<typeof import('@/lib/crypto/agent-jwt')>('@/lib/crypto/agent-jwt', (real) => ({
  ...real,
  signAgentJwt: async () => 'fake.jwt.token',
}));

// Real server-init runs deploy recovery and DB shutdown hooks on import. Stub it to a no-op.
mock.module('@/lib/server-init', () => ({}));

type StatsSubscribeCall = { source: string; onRows: (rows: unknown[]) => void; onError: () => void };
const statsSubscribeCalls: StatsSubscribeCall[] = [];
const statsSubscribeWaiters: ((call: StatsSubscribeCall) => void)[] = [];
const mockStatsUnsubscribe = mock(() => {});

function nextStatsSubscribe(): Promise<StatsSubscribeCall> {
  return new Promise((resolve) => statsSubscribeWaiters.push(resolve));
}

mockModule<typeof import('@/lib/database/subscription-service')>('@/lib/database/subscription-service', (real) => ({
  ...real,
  statsPollService: {
    subscribe: (source: string, onRows: (rows: unknown[]) => void, onError?: () => void) => {
      const call: StatsSubscribeCall = { source, onRows, onError: onError ?? (() => {}) };
      statsSubscribeCalls.push(call);
      statsSubscribeWaiters.shift()?.(call);
      return mockStatsUnsubscribe;
    },
    stop: async () => {},
  },
}));

import {
  createMuxWsHandlers,
  defaultTopicAdapter,
  parseAgentSseBlock,
} from '../mux';
import type { MuxFrameBody } from '@/lib/mux/protocol';
import type { Peer } from 'crossws';

interface FakePeer {
  id: string;
  request: Request;
  sent: { type: string; ref?: number; ok?: boolean; error?: string; topic?: string; kind?: string; payload?: unknown; count?: number }[];
  sentRaw: string[];
  closeCalls: { code?: number; reason?: string }[];
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
}

function makePeer(id: string): FakePeer {
  const peer: FakePeer = {
    id,
    request: new Request('http://localhost:3000/api/mux'),
    sent: [],
    sentRaw: [],
    closeCalls: [],
    send: (data: string) => { peer.sentRaw.push(data); peer.sent.push(JSON.parse(data)); },
    close: (code?: number, reason?: string) => { peer.closeCalls.push({ code, reason }); },
  };
  return peer;
}

function command(type: 'sub' | 'unsub', topics: string[], ref = 0): { text: () => string } {
  return { text: () => JSON.stringify({ type, ref, topics }) };
}

type AdapterCall = { topic: string; emit: (frame: MuxFrameBody) => void; signal: AbortSignal };

function makeAdapter() {
  const calls: AdapterCall[] = [];
  const adapter = mock((topic: string, emit: AdapterCall['emit'], signal: AbortSignal) => {
    calls.push({ topic, emit, signal });
  });
  return { calls, adapter };
}

const handlers = createMuxWsHandlers({ topicAdapter: () => {} });

describe('mux ws route', () => {
  let peerCounter = 0;

  beforeEach(() => {
    mockAuthenticate.mockClear();
    mockAuthenticate.mockImplementation(async () => ({ id: 'test-user' } as unknown));
  });

  afterEach(() => {
    for (const fixture of openPeers) fixture.teardown();
    openPeers.length = 0;
  });

  const openPeers: { teardown: () => void }[] = [];

  async function openWith(deps: { adapter: (topic: string, emit: AdapterCall['emit'], signal: AbortSignal) => void | Promise<void> }): Promise<{ peer: FakePeer; h: ReturnType<typeof createMuxWsHandlers> }> {
    const h = createMuxWsHandlers({ topicAdapter: deps.adapter });
    const peer = makePeer(`peer-${++peerCounter}`);
    await h.open(peer as unknown as Peer);
    openPeers.push({ teardown: () => h.close(peer as unknown as Peer) });
    return { peer, h };
  }

  it('closes the peer when auth fails', async () => {
    mockAuthenticate.mockImplementation(async () => null);
    const peer = makePeer(`peer-${++peerCounter}`);
    await handlers.open(peer as unknown as Peer);
    expect(peer.closeCalls[0]?.code).toBe(1008);
  });

  it('starts the adapter for each subscribed topic and acks the command', async () => {
    const { calls, adapter } = makeAdapter();
    const { peer, h } = await openWith({ adapter });

    await h.message(peer as unknown as Peer, command('sub', ['inventory', 'logs:s/abc']));

    expect(calls.map((c) => c.topic)).toEqual(['inventory', 'logs:s/abc']);
    expect(peer.sent).toEqual([{ type: 'ack', ref: 0, ok: true }]);
  });

  it('forwards adapter frames to the peer as event frames', async () => {
    const { calls, adapter } = makeAdapter();
    const { peer, h } = await openWith({ adapter });
    await h.message(peer as unknown as Peer, command('sub', ['inventory']));

    calls[0].emit({ topic: 'inventory', kind: 'data', payload: { type: 'init', containers: [] } });

    expect(peer.sent[1]).toEqual({
      type: 'event',
      topic: 'inventory',
      kind: 'data',
      payload: { type: 'init', containers: [] },
    });
  });

  it('re-subscribing an active topic restarts its adapter (resync)', async () => {
    const { calls, adapter } = makeAdapter();
    const { peer, h } = await openWith({ adapter });
    await h.message(peer as unknown as Peer, command('sub', ['inventory'], 1));
    await h.message(peer as unknown as Peer, command('sub', ['inventory'], 2));

    expect(calls).toHaveLength(2);
    expect(calls[0].signal.aborted).toBe(true);
    expect(calls[1].signal.aborted).toBe(false);
  });

  it('unsubscribing aborts the topic adapter', async () => {
    const { calls, adapter } = makeAdapter();
    const { peer, h } = await openWith({ adapter });
    await h.message(peer as unknown as Peer, command('sub', ['inventory'], 1));
    await h.message(peer as unknown as Peer, command('unsub', ['inventory'], 2));

    expect(calls[0].signal.aborted).toBe(true);
    expect(peer.sent.at(-1)).toEqual({ type: 'ack', ref: 2, ok: true });
  });

  it('rejects subscriptions beyond the topic limit', async () => {
    const { adapter } = makeAdapter();
    const { peer, h } = await openWith({ adapter });
    const topics = Array.from({ length: 21 }, (_, i) => `logs:server/c${i}`);

    await h.message(peer as unknown as Peer, command('sub', topics, 7));

    expect(peer.sent).toEqual([{ type: 'ack', ref: 7, ok: false, error: 'Too many topics' }]);
  });

  it('rejects malformed commands', async () => {
    const { peer, h } = await openWith({ adapter: () => {} });
    await h.message(peer as unknown as Peer, { text: () => 'not json' });
    expect(peer.sent).toEqual([]);

    await h.message(peer as unknown as Peer, { text: () => JSON.stringify({ type: 'nope' }) });
    expect(peer.sent.at(-1)).toEqual({ type: 'ack', ref: 0, ok: false, error: 'Invalid command' });
  });

  it('tears every topic down when the peer closes', async () => {
    const { calls, adapter } = makeAdapter();
    const { peer, h } = await openWith({ adapter });
    await h.message(peer as unknown as Peer, command('sub', ['inventory', 'logs:s/abc']));

    h.close(peer as unknown as Peer);

    expect(calls.every((c) => c.signal.aborted)).toBe(true);
    await h.message(peer as unknown as Peer, command('sub', ['inventory'], 9));
    expect(calls).toHaveLength(2);
  });
});

describe('parseAgentSseBlock', () => {
  it('parses plain data frames as message events', () => {
    expect(parseAgentSseBlock('data: {"lines":[]}')).toEqual({ event: 'message', data: '{"lines":[]}' });
  });

  it('parses named events and joins multi-line data', () => {
    expect(parseAgentSseBlock('event: error\ndata: {"message":\ndata: "gone"}')).toEqual({
      event: 'error',
      data: '{"message":\n"gone"}',
    });
  });

  it('ignores comment lines', () => {
    expect(parseAgentSseBlock(': keepalive\ndata: 1')).toEqual({ event: 'message', data: '1' });
  });
});

describe('logs adapter pipe', () => {
  const origFetch = globalThis.fetch;
  const origSetTimeout = globalThis.setTimeout;

  function sseBody(text: string): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });
  }

  beforeEach(() => {
    mockFindByName.mockImplementation(async () => ({ name: 'server1', agentUrl: 'http://agent' }));
    mockGetPrivateKeyForHost.mockImplementation(async () => ({ kty: 'OKP' } as object));
  });

  afterEach(() => {
    (globalThis as unknown as Record<string, unknown>).fetch = origFetch;
    (globalThis as unknown as Record<string, unknown>).setTimeout = origSetTimeout;
    mockFindByName.mockImplementation(async () => null);
    mockGetPrivateKeyForHost.mockImplementation(async () => null);
  });

  it('re-emits agent frames as mux frames', async () => {
    (globalThis as unknown as Record<string, unknown>).fetch = mock(async () =>
      new Response(sseBody(
        'data: {"lines":[{"text":"hi","stream":"stdout"}]}\n\n' +
        'event: backlog_done\ndata: {}\n\n' +
        'event: stream_end\ndata: {}\n\n',
      ))) as unknown as typeof fetch;

    const h = createMuxWsHandlers({ topicAdapter: defaultTopicAdapter });
    const peer = makePeer('pipe-peer');
    await h.open(peer as unknown as Peer);
    await h.message(peer as unknown as Peer, command('sub', ['logs:server1/abc'], 1));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const events = peer.sent.filter((f) => f.type === 'event');
    expect(events.map((e) => e.kind)).toEqual(['backlog_start', 'data', 'backlog_done', 'stream_end']);
    expect(events[1].payload).toEqual({ lines: [{ text: 'hi', stream: 'stdout' }] });
    h.close(peer as unknown as Peer);
  });

  it('retries the agent fetch with capped backoff, reports degradation once, and recovers', async () => {
    let pending: { fn: () => void; ms: number }[] = [];
    const delays: number[] = [];
    spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      pending.push({ fn, ms: ms ?? 0 });
      delays.push(ms ?? 0);
      return pending.length;
    }) as unknown as typeof setTimeout);
    let attempts = 0;
    (globalThis as unknown as Record<string, unknown>).fetch = mock(async () => {
      attempts++;
      if (attempts <= 2) throw new Error('agent down');
      return new Response(sseBody('data: {"lines":[{"text":"back","stream":"stdout"}]}\n\n'));
    }) as unknown as typeof fetch;
    const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

    const h = createMuxWsHandlers({ topicAdapter: defaultTopicAdapter });
    const peer = makePeer('pipe-peer-2');
    await h.open(peer as unknown as Peer);
    await h.message(peer as unknown as Peer, command('sub', ['logs:server1/abc'], 1));
    await settle();

    for (let i = 0; i < 2; i++) {
      const queue = pending;
      pending = [];
      for (const timer of queue) timer.fn();
      await settle();
    }

    const events = peer.sent.filter((f) => f.type === 'event');
    expect(delays).toEqual([1000, 2000]);
    expect(events.filter((e) => e.kind === 'backlog_start')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'data')).toHaveLength(1);
    const errors = events.filter((e) => e.kind === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0].payload as { gone?: boolean }).gone).toBe(false);
    expect((errors[0].payload as { message?: string }).message).toContain('retrying');
    h.close(peer as unknown as Peer);
  });

  it('emits a gone error for permanent failures', async () => {
    mockFindByName.mockImplementation(async () => null);
    (globalThis as unknown as Record<string, unknown>).fetch = mock(async () => {
      throw new Error('should not fetch');
    }) as unknown as typeof fetch;

    const h = createMuxWsHandlers({ topicAdapter: defaultTopicAdapter });
    const peer = makePeer('pipe-peer-3');
    await h.open(peer as unknown as Peer);
    await h.message(peer as unknown as Peer, command('sub', ['logs:server1/abc'], 1));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const events = peer.sent.filter((f) => f.type === 'event');
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('error');
    expect((events[0].payload as { gone?: boolean }).gone).toBe(true);
    expect((events[0].payload as { message?: string }).message).toContain('Unknown host');
    h.close(peer as unknown as Peer);
  });
});

type SentFrame = FakePeer['sent'][number];

function dataFrames(peer: FakePeer, topic: string): SentFrame[] {
  return peer.sent.filter((f) => f.type === 'event' && f.topic === topic && f.kind === 'data');
}

describe('control topics (settings, stack-status)', () => {
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  async function until(predicate: () => boolean, maxRounds = 50): Promise<void> {
    for (let i = 0; i < maxRounds && !predicate(); i++) await settle();
  }

  beforeAll(async () => {
    // Pre-warm the adapters' dynamic import chain so init delivery is pure microtasks per test.
    await import('@/lib/server-init');
    await import('@/lib/settings/settings-broadcast-service');
    await import('@/lib/stacks/stack-status-broadcast-service');
    await import('@/lib/sse/channels/stack-status');
  });
  const expectedStackEntry = {
    host: 'server1',
    stack: 'plex',
    containers: [
      {
        id: 'c1',
        name: 'plex',
        status: 'running',
        image: 'plexinc/pms-docker',
        service: 'plex',
        ports: [],
        mounts: [],
      },
    ],
    updated_at: '2026-03-21T00:00:00.000Z',
  };
  let peerCounter = 0;

  beforeEach(() => {
    mockAuthenticate.mockImplementation(async () => ({ id: 'test-user' } as unknown));
    settingsHarness.clients.length = 0;
    stackHarness.clients.length = 0;
    settingsState.all = new Map([['theme', 'dark']]);
    settingsState.values = new Map([['theme', 'light']]);
    stackState.snapshot = [
      {
        host: 'server1',
        containerId: 'c1',
        name: 'plex',
        image: 'plexinc/pms-docker',
        state: 'running',
        composeProject: 'plex',
        serviceKey: 'plex/plex',
        startedAt: null,
        finishedAt: null,
        exitCode: null,
        updatedAt: new Date('2026-03-21T00:00:00Z'),
        labels: {},
        ports: [],
        mounts: [],
      },
    ];
  });

  it('delivers initial state for settings and stack-status on one connection', async () => {
    const h = createMuxWsHandlers({ topicAdapter: defaultTopicAdapter });
    const peer = makePeer(`ctl-${++peerCounter}`);
    await h.open(peer as unknown as Peer);
    await h.message(peer as unknown as Peer, command('sub', ['settings', 'stack-status'], 1));
    await until(() => dataFrames(peer, 'settings').length >= 1 && dataFrames(peer, 'stack-status').length >= 1);

    expect(dataFrames(peer, 'settings')).toHaveLength(1);
    expect(dataFrames(peer, 'settings')[0].payload).toEqual({ type: 'init', settings: { theme: 'dark' } });
    expect(dataFrames(peer, 'stack-status')).toHaveLength(1);
    expect(dataFrames(peer, 'stack-status')[0].payload).toEqual([expectedStackEntry]);
    expect(peer.sent.filter((f) => f.type === 'ack')).toEqual([{ type: 'ack', ref: 1, ok: true }]);
    h.close(peer as unknown as Peer);
  });

  it('forwards live settings changes and stack deploy updates as data frames', async () => {
    const h = createMuxWsHandlers({ topicAdapter: defaultTopicAdapter });
    const peer = makePeer(`ctl-${++peerCounter}`);
    await h.open(peer as unknown as Peer);
    await h.message(peer as unknown as Peer, command('sub', ['settings', 'stack-status'], 1));
    await until(() => dataFrames(peer, 'settings').length >= 1 && dataFrames(peer, 'stack-status').length >= 1);

    settingsHarness.clients.at(-1)?.emit('notification', { channel: 'settings_change', payload: 'theme' });
    await until(() => dataFrames(peer, 'settings').length >= 2);
    expect(dataFrames(peer, 'settings')[1].payload).toEqual({ type: 'change', key: 'theme', value: 'light' });

    const outcome = { deployId: 7, status: 'succeeded', action: 'deploy', trigger: 'ui' };
    stackHarness.clients.at(-1)?.emit('notification', {
      channel: 'deploy_change',
      payload: JSON.stringify({ stack: 'plex', host: 'server1', outcome }),
    });
    await until(() => dataFrames(peer, 'stack-status').length >= 2);
    expect(dataFrames(peer, 'stack-status')[1].payload).toEqual({
      type: 'deploy_changed',
      stack: 'plex',
      host: 'server1',
      outcome,
    });
    h.close(peer as unknown as Peer);
  });

  it('stops delivery on unsub and re-delivers current state on re-subscribe', async () => {
    const h = createMuxWsHandlers({ topicAdapter: defaultTopicAdapter });
    const peer = makePeer(`ctl-${++peerCounter}`);
    await h.open(peer as unknown as Peer);
    await h.message(peer as unknown as Peer, command('sub', ['settings', 'stack-status'], 1));
    await until(() => dataFrames(peer, 'settings').length >= 1 && dataFrames(peer, 'stack-status').length >= 1);

    await h.message(peer as unknown as Peer, command('unsub', ['settings', 'stack-status'], 2));
    await settle();
    const afterUnsub = peer.sent.length;
    settingsHarness.clients.at(-1)?.emit('notification', { channel: 'settings_change', payload: 'theme' });
    stackHarness.clients.at(-1)?.emit('notification', {
      channel: 'deploy_change',
      payload: JSON.stringify({ stack: 'plex', host: 'server1' }),
    });
    await settle();
    await settle();
    expect(peer.sent.length).toBe(afterUnsub);
    expect(dataFrames(peer, 'settings')).toHaveLength(1);
    expect(dataFrames(peer, 'stack-status')).toHaveLength(1);

    await h.message(peer as unknown as Peer, command('sub', ['settings', 'stack-status'], 3));
    await until(() => dataFrames(peer, 'settings').length >= 2 && dataFrames(peer, 'stack-status').length >= 2);
    expect(dataFrames(peer, 'settings')[1].payload).toEqual({ type: 'init', settings: { theme: 'dark' } });
    expect(dataFrames(peer, 'stack-status')[1].payload).toEqual([expectedStackEntry]);
    h.close(peer as unknown as Peer);
  });
});

describe('stats topic adapters', () => {
  beforeEach(() => {
    statsSubscribeCalls.length = 0;
    mockStatsUnsubscribe.mockClear();
  });

  it('subscribes each stats topic to its poll source and replays no history', async () => {
    for (const [topic, source] of [
      ['stats:docker', 'docker'],
      ['stats:zfs', 'zfs'],
      ['stats:proxmox', 'proxmox'],
    ] as const) {
      const h = createMuxWsHandlers({ topicAdapter: defaultTopicAdapter });
      const peer = makePeer(`stats-${source}`);
      await h.open(peer as unknown as Peer);
      const subscribed = nextStatsSubscribe();
      await h.message(peer as unknown as Peer, command('sub', [topic], 1));
      const call = await subscribed;

      expect(call.source).toBe(source);
      expect(peer.sent).toEqual([{ type: 'ack', ref: 1, ok: true }]);
      h.close(peer as unknown as Peer);
    }
  });

  it('publishes poll deltas as data frames in the existing wire shape', async () => {
    const h = createMuxWsHandlers({ topicAdapter: defaultTopicAdapter });
    const peer = makePeer('stats-delta');
    await h.open(peer as unknown as Peer);
    const subscribed = nextStatsSubscribe();
    await h.message(peer as unknown as Peer, command('sub', ['stats:docker'], 1));
    const call = await subscribed;

    call.onRows([{ time: 1000, host: 'server1', cpu_percent: 1.5 }]);

    expect(peer.sentRaw).toContain(
      '{"type":"event","topic":"stats:docker","kind":"data","payload":[{"time":1000,"host":"server1","cpu_percent":1.5}]}',
    );
    h.close(peer as unknown as Peer);
  });

  it('surfaces poll failure as a recoverable error frame', async () => {
    const h = createMuxWsHandlers({ topicAdapter: defaultTopicAdapter });
    const peer = makePeer('stats-error');
    await h.open(peer as unknown as Peer);
    const subscribed = nextStatsSubscribe();
    await h.message(peer as unknown as Peer, command('sub', ['stats:zfs'], 1));
    const call = await subscribed;

    call.onError();

    expect(peer.sentRaw).toContain(
      '{"type":"event","topic":"stats:zfs","kind":"error","payload":{"message":"Stats polling failed, retrying","gone":false}}',
    );
    h.close(peer as unknown as Peer);
  });

  it('unsubscribing stops the poll subscription', async () => {
    const h = createMuxWsHandlers({ topicAdapter: defaultTopicAdapter });
    const peer = makePeer('stats-unsub');
    await h.open(peer as unknown as Peer);
    const subscribed = nextStatsSubscribe();
    await h.message(peer as unknown as Peer, command('sub', ['stats:proxmox'], 1));
    await subscribed;

    await h.message(peer as unknown as Peer, command('unsub', ['stats:proxmox'], 2));

    expect(mockStatsUnsubscribe).toHaveBeenCalledTimes(1);
    h.close(peer as unknown as Peer);
  });

  it('rejects an unregistered stats source with a gone error frame', async () => {
    const emitted: MuxFrameBody[] = [];
    await defaultTopicAdapter('stats:bogus', (frame) => emitted.push(frame), new AbortController().signal);

    expect(emitted).toEqual([
      { topic: 'stats:bogus', kind: 'error', payload: { message: 'Invalid stats topic', gone: true } },
    ]);
    expect(statsSubscribeCalls).toHaveLength(0);
  });
});

describe('frame wire format', () => {
  it('serializes existing kinds byte-identically', async () => {
    const { calls, adapter } = makeAdapter();
    const h = createMuxWsHandlers({ topicAdapter: adapter });
    const peer = makePeer('wire-existing');
    await h.open(peer as unknown as Peer);
    await h.message(peer as unknown as Peer, command('sub', ['inventory'], 1));
    calls[0].emit({ topic: 'inventory', kind: 'data', payload: { type: 'init', containers: [] } });
    calls[0].emit({ topic: 'inventory', kind: 'backlog_start', payload: {} });
    calls[0].emit({ topic: 'inventory', kind: 'backlog_done', payload: {} });
    calls[0].emit({ topic: 'inventory', kind: 'stream_end', payload: {} });
    calls[0].emit({ topic: 'inventory', kind: 'error', payload: { message: 'x', gone: true } });

    expect(peer.sentRaw.slice(1)).toEqual([
      '{"type":"event","topic":"inventory","kind":"data","payload":{"type":"init","containers":[]}}',
      '{"type":"event","topic":"inventory","kind":"backlog_start","payload":{}}',
      '{"type":"event","topic":"inventory","kind":"backlog_done","payload":{}}',
      '{"type":"event","topic":"inventory","kind":"stream_end","payload":{}}',
      '{"type":"event","topic":"inventory","kind":"error","payload":{"message":"x","gone":true}}',
    ]);
    h.close(peer as unknown as Peer);
  });

  it('serializes dropped frames as kind, topic, count', async () => {
    const { calls, adapter } = makeAdapter();
    const h = createMuxWsHandlers({ topicAdapter: adapter });
    const peer = makePeer('wire-dropped');
    await h.open(peer as unknown as Peer);
    await h.message(peer as unknown as Peer, command('sub', ['stats:docker'], 1));
    calls[0].emit({ topic: 'stats:docker', kind: 'dropped', count: 3 });

    expect(peer.sentRaw[1]).toBe('{"type":"event","topic":"stats:docker","kind":"dropped","count":3}');
    h.close(peer as unknown as Peer);
  });
});

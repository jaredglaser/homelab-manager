import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { mockModule } from '@/lib/test/mock-module';

const mockAuthenticate = mock(async () => ({ id: 'test-user' } as unknown));
const mockFindByName = mock(async (_: string) => null as null | { name: string; agentUrl: string });
const mockGetPrivateKeyForHost = mock(async (_: string) => null as null | object);

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

import {
  createMuxWsHandlers,
  defaultTopicAdapter,
  parseAgentSseBlock,
} from '../mux';
import type { Peer } from 'crossws';

interface FakePeer {
  id: string;
  request: Request;
  sent: { type: string; ref?: number; ok?: boolean; error?: string; topic?: string; kind?: string; payload?: unknown }[];
  closeCalls: { code?: number; reason?: string }[];
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
}

function makePeer(id: string): FakePeer {
  const peer: FakePeer = {
    id,
    request: new Request('http://localhost:3000/api/mux'),
    sent: [],
    closeCalls: [],
    send: (data: string) => { peer.sent.push(JSON.parse(data)); },
    close: (code?: number, reason?: string) => { peer.closeCalls.push({ code, reason }); },
  };
  return peer;
}

function command(type: 'sub' | 'unsub', topics: string[], ref = 0): { text: () => string } {
  return { text: () => JSON.stringify({ type, ref, topics }) };
}

type AdapterCall = { topic: string; emit: (frame: { topic: string; kind: string; payload: unknown }) => void; signal: AbortSignal };

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

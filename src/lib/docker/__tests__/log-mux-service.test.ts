import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import {
  attachSession,
  mutateSession,
  parseMuxKey,
  isValidSessionId,
  MAX_MUX_STREAMS,
  _resetLogMuxSessions,
  _flushLogMuxPipes,
} from '../log-mux-service';
import { waitForCondition } from '@/lib/test/wait-for-condition';
import type { SseEmitter } from '@/lib/sse/create-sse-stream';

const originalFetch = globalThis.fetch;

interface RecordedFrame {
  kind: 'data' | 'event';
  name?: string;
  payload: unknown;
}

function makeEmitter(): SseEmitter & { frames: RecordedFrame[] } {
  const frames: RecordedFrame[] = [];
  return {
    frames,
    data: (payload) => frames.push({ kind: 'data', payload }),
    event: (name, payload) => frames.push({ kind: 'event', name, payload }),
    raw: () => {},
    close: () => {},
  };
}

function agentStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

function mockServerModules(hosts: Record<string, { agentUrl: string } | null>) {
  const dbClient = { getPool: () => ({}) };
  mock.module('@/lib/clients/database-client', () => ({
    databaseConnectionManager: { getClient: mock(async () => dbClient) },
  }));
  mock.module('@/lib/config/database-config', () => ({
    loadDatabaseConfig: mock(() => ({})),
  }));
  mock.module('@/lib/database/repositories/host-repository', () => ({
    HostRepository: class {
      async findByName(name: string) {
        return hosts[name] ?? null;
      }
    },
  }));
  mock.module('@/lib/database/repositories/agent-keypairs-repository', () => ({
    AgentKeypairsRepository: class {
      async getPrivateKeyForHost(name: string) {
        return hosts[name] ? 'private-key' : null;
      }
    },
  }));
  mock.module('@/lib/crypto/master-key', () => ({
    loadMasterKeyring: mock(async () => ({})),
  }));
  mock.module('@/lib/crypto/agent-jwt', () => ({
    signAgentJwt: mock(async () => 'signed-jwt'),
  }));
}

beforeEach(() => {
  _resetLogMuxSessions();
  mock.restore();
});

afterEach(() => {
  _resetLogMuxSessions();
  globalThis.fetch = originalFetch;
});

describe('parseMuxKey', () => {
  it('accepts host/container pairs using the agent id grammar', () => {
    expect(parseMuxKey('server1/abc123')).toEqual({ host: 'server1', containerId: 'abc123' });
  });

  it('rejects missing parts or forbidden characters', () => {
    expect(parseMuxKey('noseparator')).toBeNull();
    expect(parseMuxKey('/abc')).toBeNull();
    expect(parseMuxKey('server/')).toBeNull();
    expect(parseMuxKey('ser ver/abc')).toBeNull();
    expect(parseMuxKey('server/ab c')).toBeNull();
  });
});

describe('isValidSessionId', () => {
  it('accepts uuid-shaped ids and rejects everything else', () => {
    expect(isValidSessionId('01890a5d-ac96-774b-bcce-b302099a8057')).toBe(true);
    expect(isValidSessionId('short')).toBe(false);
    expect(isValidSessionId('has space in it')).toBe(false);
    expect(isValidSessionId(42)).toBe(false);
    expect(isValidSessionId(null)).toBe(false);
  });
});

describe('mutateSession', () => {
  it('returns unknown-session before the GET attaches', async () => {
    const result = await mutateSession('01890a5d-ac96-774b-bcce-b302099a8057', ['s/abc'], []);
    expect(result).toEqual({ ok: false, reason: 'unknown-session' });
  });

  it('streams the subscribed key tagged with its id after attach', async () => {
    mockServerModules({ server1: { agentUrl: 'http://agent1' } });
    globalThis.fetch = mock(async () => new Response(
      agentStream([
        'data: {"text":"line-1","stream":"stdout"}\n\n',
        'event: backlog_done\ndata: {}\n\n',
        'event: stream_end\ndata: {}\n\n',
      ]),
      { status: 200 },
    )) as unknown as typeof fetch;

    const emit = makeEmitter();
    const cleanup = attachSession('01890a5d-ac96-774b-bcce-b302099a8057', emit);
    const result = await mutateSession('01890a5d-ac96-774b-bcce-b302099a8057', ['server1/abc'], []);

    expect(result).toEqual({ ok: true });
    await _flushLogMuxPipes();
    expect(emit.frames).toEqual([
      { kind: 'event', name: 'backlog_start', payload: { key: 'server1/abc' } },
      { kind: 'data', payload: { key: 'server1/abc', line: { text: 'line-1', stream: 'stdout' } } },
      { kind: 'event', name: 'backlog_done', payload: { key: 'server1/abc' } },
      { kind: 'event', name: 'stream_end', payload: { key: 'server1/abc' } },
    ]);
    cleanup();
  });

  it('resynchronizes an already-active key by reopening its upstream', async () => {
    mockServerModules({ server1: { agentUrl: 'http://agent1' } });
    const fetchMock = mock(async (_url: string | URL, _init?: RequestInit) => new Response(
      agentStream(['data: {"text":"backlog","stream":"stdout"}\n\n']),
      { status: 200 },
    ));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const emit = makeEmitter();
    const cleanup = attachSession('01890a5d-ac96-774b-bcce-b302099a8057', emit);
    await mutateSession('01890a5d-ac96-774b-bcce-b302099a8057', ['server1/abc'], []);
    await _flushLogMuxPipes();
    await mutateSession('01890a5d-ac96-774b-bcce-b302099a8057', ['server1/abc'], []);
    await _flushLogMuxPipes();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const backlogStarts = emit.frames.filter((f) => f.kind === 'event' && f.name === 'backlog_start');
    expect(backlogStarts).toHaveLength(2);
    cleanup();
  });

  it('stops delivering frames for an unsubscribed key', async () => {
    mockServerModules({ server1: { agentUrl: 'http://agent1' } });
    const encoder = new TextEncoder();
    const upstream: { pushFrame?: (frame: string) => void } = {};
    globalThis.fetch = mock(async (_url: string | URL, init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        upstream.pushFrame = (frame) => controller.enqueue(encoder.encode(frame));
        // An aborted fetch errors its body stream; model that so the pipe settles.
        init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
      },
    }), { status: 200 })) as unknown as typeof fetch;

    const emit = makeEmitter();
    const cleanup = attachSession('01890a5d-ac96-774b-bcce-b302099a8057', emit);
    await mutateSession('01890a5d-ac96-774b-bcce-b302099a8057', ['server1/abc'], []);
    await waitForCondition(() => emit.frames.length >= 1, { message: 'expected backlog_start' });

    upstream.pushFrame?.('data: {"text":"before","stream":"stdout"}\n\n');
    await waitForCondition(() => emit.frames.length >= 2, { message: 'expected the pushed line to be delivered' });
    const countAfterFirst = emit.frames.length;

    await mutateSession('01890a5d-ac96-774b-bcce-b302099a8057', [], ['server1/abc']);
    await _flushLogMuxPipes();
    try {
      upstream.pushFrame?.('data: {"text":"after","stream":"stdout"}\n\n');
    } catch {
      // Upstream already errored by the abort.
    }
    await _flushLogMuxPipes();
    expect(emit.frames.length).toBe(countAfterFirst);
    cleanup();
  });

  it('aborts upstreams when the SSE response tears down', async () => {
    mockServerModules({ server1: { agentUrl: 'http://agent1' } });
    const capturedSignals: AbortSignal[] = [];
    globalThis.fetch = mock(async (_url: string | URL, init?: RequestInit) => {
      capturedSignals.push(init?.signal ?? new AbortController().signal);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
        },
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const emit = makeEmitter();
    const cleanup = attachSession('01890a5d-ac96-774b-bcce-b302099a8057', emit);
    await mutateSession('01890a5d-ac96-774b-bcce-b302099a8057', ['server1/abc'], []);
    // Wait for the upstream fetch before tearing down, otherwise the abort
    // races the pipe startup and the fetch may see an already-aborted signal.
    await waitForCondition(() => capturedSignals.length > 0, { message: 'expected the agent fetch to start' });

    cleanup();
    await _flushLogMuxPipes();
    expect(capturedSignals[0]?.aborted).toBe(true);
  });

  it('reports unknown hosts as a per-key error without failing the session', async () => {
    mockServerModules({ ghost: null });
    globalThis.fetch = mock(async () => new Response(agentStream([]), { status: 200 })) as unknown as typeof fetch;

    const emit = makeEmitter();
    const cleanup = attachSession('01890a5d-ac96-774b-bcce-b302099a8057', emit);
    const result = await mutateSession('01890a5d-ac96-774b-bcce-b302099a8057', ['ghost/abc'], []);

    expect(result).toEqual({ ok: true });
    await _flushLogMuxPipes();
    expect(emit.frames).toEqual([
      { kind: 'event', name: 'error', payload: { key: 'ghost/abc', message: 'Unknown host: ghost', gone: false } },
    ]);
    cleanup();
  });

  it('rejects invalid keys before mutating anything', async () => {
    globalThis.fetch = mock(async () => new Response(agentStream([]), { status: 200 })) as unknown as typeof fetch;
    const emit = makeEmitter();
    const cleanup = attachSession('01890a5d-ac96-774b-bcce-b302099a8057', emit);

    const result = await mutateSession('01890a5d-ac96-774b-bcce-b302099a8057', ['bad key'], []);

    expect(result).toEqual({ ok: false, reason: 'invalid-key' });
    cleanup();
  });

  it('enforces the per-session stream cap', async () => {
    globalThis.fetch = mock(async () => new Response(agentStream([]), { status: 200 })) as unknown as typeof fetch;
    const emit = makeEmitter();
    const sessionId = '01890a5d-ac96-774b-bcce-b302099a8057';
    const cleanup = attachSession(sessionId, emit);

    await mutateSession(sessionId, Array.from({ length: MAX_MUX_STREAMS }, (_, i) => `h/c${i}`), []);
    const result = await mutateSession(sessionId, ['h/overflow'], []);

    expect(result).toEqual({ ok: false, reason: 'too-many-streams' });
    cleanup();
  });

  it('replaces a stale session when the same id reattaches', async () => {
    mockServerModules({ server1: { agentUrl: 'http://agent1' } });
    let fetchCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCount++;
      return new Response(agentStream([]), { status: 200 });
    }) as unknown as typeof fetch;

    const sessionId = '01890a5d-ac96-774b-bcce-b302099a8057';
    const firstCleanup = attachSession(sessionId, makeEmitter());
    await mutateSession(sessionId, ['server1/abc'], []);
    await _flushLogMuxPipes();
    // Client reconnects with the same session id before the first SSE response died.
    const secondCleanup = attachSession(sessionId, makeEmitter());
    await mutateSession(sessionId, ['server1/abc'], []);
    await _flushLogMuxPipes();

    expect(fetchCount).toBe(2);
    secondCleanup();
    firstCleanup();
  });
});

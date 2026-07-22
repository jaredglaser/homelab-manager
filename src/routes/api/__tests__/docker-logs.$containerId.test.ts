import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';

mock.module('@/lib/auth/sse-auth', () => ({
  authenticateSSE: mock(async () => ({ id: 1, role: 'admin' })),
}));

mock.module('@/lib/clients/database-client', () => ({
  databaseConnectionManager: {
    getClient: mock(async () => ({ getPool: () => ({}) })),
  },
}));

mock.module('@/lib/config/database-config', () => ({
  loadDatabaseConfig: mock(() => ({})),
}));

interface FakeManagedHost {
  id: number;
  name: string;
  agentUrl: string;
}

const findByName = mock(async (_name: string): Promise<FakeManagedHost | null> => ({
  id: 1,
  name: 'host1',
  agentUrl: 'https://agent.example/api',
}));

mock.module('@/lib/database/repositories/host-repository', () => ({
  HostRepository: mock().mockImplementation(() => ({ findByName })),
}));

const getPrivateKeyForHost = mock(async (_hostName: string): Promise<CryptoKey | null> => ({}) as CryptoKey);

mock.module('@/lib/database/repositories/agent-keypairs-repository', () => ({
  AgentKeypairsRepository: mock().mockImplementation(() => ({ getPrivateKeyForHost })),
}));

mock.module('@/lib/crypto/master-key', () => ({
  loadMasterKeyring: mock(async () => ({})),
}));

mock.module('@/lib/crypto/agent-jwt', () => ({
  signAgentJwt: mock(async () => 'signed.jwt.token'),
}));

// Imported after the mocks above so the route's dynamic imports resolve to
// the mocked modules instead of hitting a real database or agent.
const { Route } = await import('@/routes/api/docker-logs.$containerId');

type RouteHandler = (args: { request: Request; params: { containerId: string } }) => Promise<Response>;

function getHandler(): RouteHandler {
  const handlers = Route.options.server!.handlers as unknown as { GET: RouteHandler };
  return handlers.GET;
}

function makeRequest(url: string, ac: AbortController): Request {
  return new Request(url, { signal: ac.signal });
}

function readerOf(res: Response): ReadableStreamDefaultReader<Uint8Array> {
  if (!res.body) throw new Error('Response had no body');
  return res.body.getReader();
}

async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value, done } = await reader.read();
  if (done) return '';
  return new TextDecoder().decode(value);
}

/** A ReadableStream standing in for the agent's already-framed SSE log body. */
function agentBodyStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i]));
      i += 1;
    },
  });
}

describe('GET /api/docker-logs/$containerId', () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    errorSpy.mockRestore();
    findByName.mockClear();
    getPrivateKeyForHost.mockClear();
  });

  it('returns 401 when authenticateSSE returns null', async () => {
    const { authenticateSSE } = require('@/lib/auth/sse-auth') as { authenticateSSE: ReturnType<typeof mock> };
    authenticateSSE.mockImplementationOnce(async () => null);

    const ac = new AbortController();
    const res = await getHandler()({
      request: makeRequest('http://localhost/api/docker-logs/c1?host=host1', ac),
      params: { containerId: 'c1' },
    });

    expect(res.status).toBe(401);
    ac.abort();
  });

  it('returns 400 when the host query parameter is missing', async () => {
    const ac = new AbortController();
    const res = await getHandler()({
      request: makeRequest('http://localhost/api/docker-logs/c1', ac),
      params: { containerId: 'c1' },
    });

    expect(res.status).toBe(400);
    ac.abort();
  });

  it('returns 404 when the host is unknown', async () => {
    findByName.mockImplementationOnce(async () => null);

    const ac = new AbortController();
    const res = await getHandler()({
      request: makeRequest('http://localhost/api/docker-logs/c1?host=ghost', ac),
      params: { containerId: 'c1' },
    });

    expect(res.status).toBe(404);
    ac.abort();
  });

  it('returns 503 when no agent keypair exists for the host', async () => {
    getPrivateKeyForHost.mockImplementationOnce(async () => null);

    const ac = new AbortController();
    const res = await getHandler()({
      request: makeRequest('http://localhost/api/docker-logs/c1?host=host1', ac),
      params: { containerId: 'c1' },
    });

    expect(res.status).toBe(503);
    ac.abort();
  });

  it('pipes the agent body through with the standard SSE headers and the ": ok" flush first', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(agentBodyStream(['data: log line 1\n\n', 'data: log line 2\n\n']), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );

    const ac = new AbortController();
    const res = await getHandler()({
      request: makeRequest('http://localhost/api/docker-logs/c1?host=host1', ac),
      params: { containerId: 'c1' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
    expect(res.headers.get('Connection')).toBe('keep-alive');

    const reader = readerOf(res);
    expect(await readFrame(reader)).toBe(': ok\n\n');
    expect(await readFrame(reader)).toBe('data: log line 1\n\n');
    expect(await readFrame(reader)).toBe('data: log line 2\n\n');

    ac.abort();
    reader.cancel();
  });

  it('carries the shared heartbeat cadence so a quiet log stream does not go idle', async () => {
    const setSpy = spyOn(globalThis, 'setInterval');
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(agentBodyStream([]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );

    const ac = new AbortController();
    await getHandler()({
      request: makeRequest('http://localhost/api/docker-logs/c1?host=host1', ac),
      params: { containerId: 'c1' },
    });

    // Before routing through createSseStream, this route had no heartbeat
    // of its own: a quiet container's log stream would sit silent past
    // idle timeouts, same failure mode #323 fixed for broadcast streams.
    expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 5000);

    setSpy.mockRestore();
    ac.abort();
  });

  it('returns 502 for an opaque agent redirect', async () => {
    // Simulates what `redirect: 'manual'` produces when the agent issues a redirect.
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      { type: 'opaqueredirect', status: 0, ok: false, body: null } as unknown as Response,
    );

    const ac = new AbortController();
    const res = await getHandler()({
      request: makeRequest('http://localhost/api/docker-logs/c1?host=host1', ac),
      params: { containerId: 'c1' },
    });

    expect(res.status).toBe(502);
    ac.abort();
  });

  it('forwards the agent status and body text when the agent request fails', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('agent said no', { status: 500 }),
    );

    const ac = new AbortController();
    const res = await getHandler()({
      request: makeRequest('http://localhost/api/docker-logs/c1?host=host1', ac),
      params: { containerId: 'c1' },
    });

    expect(res.status).toBe(500);
    expect(await res.text()).toBe('agent said no');
    ac.abort();
  });
});

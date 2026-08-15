import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';

mock.module('@/lib/clients/database-client', () => ({
  databaseConnectionManager: {
    getClient: mock(async () => ({ getPool: () => ({}) })),
  },
}));

mock.module('@/lib/config/database-config', () => ({
  loadDatabaseConfig: mock(() => ({})),
}));

interface FakeApiTokenMatch {
  tokenId: number;
  scopes: string[];
}

const findMatchingApiToken = mock(
  async (_token: string, _repo: unknown): Promise<FakeApiTokenMatch | null> => ({
    tokenId: 1,
    scopes: ['mcp:hosts:read'],
  }),
);

mock.module('@/lib/auth/api-token-auth', () => ({ findMatchingApiToken }));

const updateLastUsed = mock(async (_id: number) => {});

mock.module('@/lib/database/repositories/api-token-repository', () => ({
  ApiTokenRepository: mock().mockImplementation(() => ({ updateLastUsed })),
}));

const buildMcpToolContext = mock(async () => ({
  pool: {},
  scopes: ['hosts:read'],
  callAgent: mock(async () => new Response('ok')),
}));

mock.module('@/lib/mcp/context', () => ({ buildMcpToolContext }));

const connect = mock(async () => {});
const buildMcpServer = mock(() => ({ connect }));

mock.module('@/lib/mcp/server', () => ({ buildMcpServer }));

const handleRequest = mock(async (_req: Request) => new Response('mcp-response', { status: 200 }));

class FakeTransport {
  handleRequest = handleRequest;
}

mock.module('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js', () => ({
  WebStandardStreamableHTTPServerTransport: FakeTransport,
}));

const { Route } = await import('@/routes/api/mcp');

type RouteHandler = (args: { request: Request }) => Promise<Response>;

function getHandler(): RouteHandler {
  const handlers = Route.options.server!.handlers as unknown as { POST: RouteHandler };
  return handlers.POST;
}

function makeRequest(url: string, init: RequestInit = {}): Request {
  return new Request(url, { method: 'POST', ...init });
}

describe('POST /api/mcp', () => {
  const originalFlag = process.env.MCP_ENABLED;

  beforeEach(() => {
    process.env.MCP_ENABLED = 'true';
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.MCP_ENABLED;
    } else {
      process.env.MCP_ENABLED = originalFlag;
    }
    findMatchingApiToken.mockClear();
    updateLastUsed.mockClear();
    buildMcpToolContext.mockClear();
    buildMcpServer.mockClear();
    connect.mockClear();
    handleRequest.mockClear();
  });

  it('returns 404 when MCP_ENABLED is not "true"', async () => {
    process.env.MCP_ENABLED = 'false';

    const res = await getHandler()({ request: makeRequest('http://localhost/api/mcp') });

    expect(res.status).toBe(404);
    expect(findMatchingApiToken).not.toHaveBeenCalled();
  });

  it('returns 404 when MCP_ENABLED is unset', async () => {
    delete process.env.MCP_ENABLED;

    const res = await getHandler()({ request: makeRequest('http://localhost/api/mcp') });

    expect(res.status).toBe(404);
    expect(findMatchingApiToken).not.toHaveBeenCalled();
  });

  it('returns 401 when no Authorization header is present', async () => {
    const res = await getHandler()({ request: makeRequest('http://localhost/api/mcp') });

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('Bearer');
    expect(findMatchingApiToken).not.toHaveBeenCalled();
  });

  it('returns 401 when the Authorization header is not a Bearer token', async () => {
    const res = await getHandler()({
      request: makeRequest('http://localhost/api/mcp', { headers: { Authorization: 'Basic abc' } }),
    });

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('Bearer');
    expect(findMatchingApiToken).not.toHaveBeenCalled();
  });

  it('returns 401 for a token that does not match', async () => {
    findMatchingApiToken.mockImplementationOnce(async () => null);

    const res = await getHandler()({
      request: makeRequest('http://localhost/api/mcp', { headers: { Authorization: 'Bearer bad-token' } }),
    });

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('Bearer');
    expect(buildMcpToolContext).not.toHaveBeenCalled();
  });

  it('returns 403 with insufficient_scope when the token carries no mcp:* scope', async () => {
    findMatchingApiToken.mockImplementationOnce(async () => ({ tokenId: 1, scopes: ['stacks:deploy'] }));

    const res = await getHandler()({
      request: makeRequest('http://localhost/api/mcp', { headers: { Authorization: 'Bearer scoped-elsewhere' } }),
    });

    expect(res.status).toBe(403);
    expect(res.headers.get('WWW-Authenticate')).toContain('insufficient_scope');
    expect(buildMcpToolContext).not.toHaveBeenCalled();
  });

  it('returns 403 when the token carries no scopes at all', async () => {
    findMatchingApiToken.mockImplementationOnce(async () => ({ tokenId: 1, scopes: [] }));

    const res = await getHandler()({
      request: makeRequest('http://localhost/api/mcp', { headers: { Authorization: 'Bearer no-scopes' } }),
    });

    expect(res.status).toBe(403);
    expect(buildMcpToolContext).not.toHaveBeenCalled();
  });

  it('accepts the umbrella mcp:read scope even without a specific mcp:*:read scope', async () => {
    findMatchingApiToken.mockImplementationOnce(async () => ({ tokenId: 1, scopes: ['mcp:read'] }));

    const res = await getHandler()({
      request: makeRequest('http://localhost/api/mcp', { headers: { Authorization: 'Bearer umbrella' } }),
    });

    expect(res.status).toBe(200);
    expect(buildMcpToolContext).toHaveBeenCalledWith({}, ['mcp:read'], expect.anything());
  });

  it('never echoes the provided token back in the response body', async () => {
    findMatchingApiToken.mockImplementationOnce(async () => null);

    const res = await getHandler()({
      request: makeRequest('http://localhost/api/mcp', { headers: { Authorization: 'Bearer super-secret-token' } }),
    });

    const body = await res.text();
    expect(body).not.toContain('super-secret-token');
  });

  it('reaches the transport for a valid token', async () => {
    const request = makeRequest('http://localhost/api/mcp', { headers: { Authorization: 'Bearer good-token' } });
    const res = await getHandler()({ request });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('mcp-response');

    expect(findMatchingApiToken).toHaveBeenCalledTimes(1);
    expect(buildMcpToolContext).toHaveBeenCalledTimes(1);
    expect(buildMcpToolContext).toHaveBeenCalledWith({}, ['mcp:hosts:read'], request.signal);
    expect(buildMcpServer).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(handleRequest).toHaveBeenCalledTimes(1);
    expect(handleRequest).toHaveBeenCalledWith(request);
    expect(updateLastUsed).toHaveBeenCalledWith(1);
  });

  it('still serves the request when the last_used_at bookkeeping write fails', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    const rejection = new Error('pool exhausted');
    let reported: () => void;
    const wasLogged = new Promise<void>((resolve) => {
      reported = resolve;
    });
    logged.mockImplementation(() => {
      reported();
    });
    updateLastUsed.mockImplementationOnce(async () => {
      throw rejection;
    });

    const request = makeRequest('http://localhost/api/mcp', { headers: { Authorization: 'Bearer good-token' } });
    const res = await getHandler()({ request });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('mcp-response');

    await wasLogged;
    expect(logged).toHaveBeenCalledWith(
      '[Mcp] Failed to update last_used_at for token 1:',
      'pool exhausted',
    );
    logged.mockRestore();
  });
});

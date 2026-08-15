import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';

const findByNameMock = mock(async (_name: string): Promise<unknown> => null);
mock.module('@/lib/database/repositories/host-repository', () => ({
  HostRepository: mock().mockImplementation(() => ({ findByName: findByNameMock })),
}));

const getPrivateKeyForHostMock = mock(async (_host: string): Promise<unknown> => null);
mock.module('@/lib/database/repositories/agent-keypairs-repository', () => ({
  AgentKeypairsRepository: mock().mockImplementation(() => ({ getPrivateKeyForHost: getPrivateKeyForHostMock })),
}));

const loadMasterKeyringMock = mock(async () => ({}));
mock.module('@/lib/crypto/master-key', () => ({
  loadMasterKeyring: loadMasterKeyringMock,
}));

const signAgentJwtMock = mock(async (_privateKey: unknown, _host: string) => 'signed.jwt.token');
mock.module('@/lib/crypto/agent-jwt', () => ({
  signAgentJwt: signAgentJwtMock,
}));

const { buildMcpToolContext } = await import('@/lib/mcp/context');
const { McpToolError } = await import('@/lib/mcp/shared');

function makeManagedHost(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    name: 'nuc1',
    agentUrl: 'https://nuc1.local:8443',
    capabilities: { docker: true, zfs: false },
    status: 'healthy',
    ...overrides,
  };
}

describe('buildMcpToolContext / callAgent', () => {
  let fetchMock: ReturnType<typeof mock>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    findByNameMock.mockClear();
    findByNameMock.mockImplementation(async () => makeManagedHost());
    getPrivateKeyForHostMock.mockClear();
    getPrivateKeyForHostMock.mockImplementation(async () => ({}) as CryptoKey);
    signAgentJwtMock.mockClear();
    loadMasterKeyringMock.mockClear();

    fetchMock = mock(async (_url: string, _init: RequestInit) => new Response('ok', { status: 200 }));
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  it('throws unknown_host when the host is not managed', async () => {
    findByNameMock.mockImplementation(async () => null);
    const ctx = await buildMcpToolContext({} as never, ['mcp:read']);

    await expect(ctx.callAgent('ghost', '/logs/abc/history')).rejects.toMatchObject({
      code: 'unknown_host',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws host_unreachable when no agent keypair exists for the host', async () => {
    getPrivateKeyForHostMock.mockImplementation(async () => null);
    const ctx = await buildMcpToolContext({} as never, ['mcp:read']);

    await expect(ctx.callAgent('nuc1', '/logs/abc/history')).rejects.toMatchObject({
      code: 'host_unreachable',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws agent_error on an unexpected redirect', async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example' } }));
    const ctx = await buildMcpToolContext({} as never, ['mcp:read']);

    await expect(ctx.callAgent('nuc1', '/logs/abc/history')).rejects.toMatchObject({
      code: 'agent_error',
    });
  });

  it('errors thrown by callAgent are real McpToolError instances', async () => {
    findByNameMock.mockImplementation(async () => null);
    const ctx = await buildMcpToolContext({} as never, ['mcp:read']);

    try {
      await ctx.callAgent('ghost', '/logs/abc/history');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(McpToolError);
    }
  });

  it('signs a JWT and forwards it as a Bearer token to the agent URL', async () => {
    const ctx = await buildMcpToolContext({} as never, ['mcp:read']);
    await ctx.callAgent('nuc1', '/logs/abc/history?limit=10');

    expect(signAgentJwtMock).toHaveBeenCalledWith(expect.anything(), 'nuc1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://nuc1.local:8443/logs/abc/history?limit=10');
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer signed.jwt.token');
  });

  it('returns the agent response unchanged on success', async () => {
    fetchMock.mockImplementation(async () => new Response('body', { status: 200 }));
    const ctx = await buildMcpToolContext({} as never, ['mcp:read']);
    const res = await ctx.callAgent('nuc1', '/logs/abc/history');

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('body');
  });

  it('aborts the agent fetch when the per-call signal fires', async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      capturedSignal = init.signal ?? undefined;
      return new Response('ok', { status: 200 });
    });

    const ctx = await buildMcpToolContext({} as never, ['mcp:read']);
    await ctx.callAgent('nuc1', '/logs/abc/history', { signal: controller.signal });

    expect(capturedSignal?.aborted).toBe(false);
    controller.abort();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('aborts the agent fetch when the request-level signal fires, even though the caller passed its own per-call signal', async () => {
    const perCallController = new AbortController();
    const requestController = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      capturedSignal = init.signal ?? undefined;
      return new Response('ok', { status: 200 });
    });

    const ctx = await buildMcpToolContext({} as never, ['mcp:read'], requestController.signal);
    await ctx.callAgent('nuc1', '/logs/abc/history', { signal: perCallController.signal });

    requestController.abort();
    expect(capturedSignal?.aborted).toBe(true);
  });
});

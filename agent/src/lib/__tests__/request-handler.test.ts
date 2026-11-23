import { describe, it, expect, mock, spyOn } from 'bun:test';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { authenticateRequest } from '../../middleware';
import { handleHealth } from '../../routes/health';
import { AGENT_IDENTITY_HEADER } from '../../types';
import { loadTrustedPublicKey } from '../jwt-auth';
import { createSseStream } from '../sse-stream';
import { createFetchHandler, type AgentFetchDeps } from '../request-handler';

const HOST = 'test-host';
const PROTOCOL = '1';

async function makeSigner() {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const trusted = await loadTrustedPublicKey(JSON.stringify(await exportJWK(publicKey)));
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer('homelab-manager')
    .setAudience(HOST)
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime('60s')
    .sign(privateKey);
  return { trusted, token };
}

const noUpgrade = { upgrade: () => false };

// The root test run installs Happy-DOM, whose Request drops the forbidden `upgrade` header, so the handler gets a plain shape.
function requestTo(path: string, headers: HeadersInit): Request {
  return { url: `http://agent.test${path}`, method: 'GET', headers: new Headers(headers) } as Request;
}

async function harness(overrides: Partial<AgentFetchDeps> = {}) {
  const { trusted, token } = await makeSigner();
  const handler = createFetchHandler({
    authenticate: (headers, pathname) => authenticateRequest(headers, trusted, pathname, HOST),
    restrictedPlainHttp: false,
    dockerAvailable: true,
    matchRoute: (request, url) => {
      if (url.pathname === '/health') return handleHealth(null, undefined);
      if (url.pathname === '/json') return Response.json({ ok: true });
      if (url.pathname === '/refused') return Response.json({ error: 'nope', code: 'invalid_json' }, { status: 400 });
      if (url.pathname === '/stream') return createSseStream(request, { onStart: (emit) => emit.data({ n: 1 }) });
      if (url.pathname === '/boom') throw new Error('route exploded');
      if (url.pathname === '/reject') return Promise.reject(new Error('route rejected'));
      return null;
    },
    ...overrides,
  });
  const send = (path: string, init: RequestInit = {}, server: Parameters<typeof handler>[1] = noUpgrade) =>
    handler(requestTo(path, { Authorization: `Bearer ${token}`, ...init.headers }), server);
  return { handler, send };
}

describe('agent identity header', () => {
  const paths: { name: string; status: number; path: string; init?: RequestInit; overrides?: Partial<AgentFetchDeps> }[] = [
    { name: 'a JSON route response', status: 200, path: '/json' },
    { name: 'a route error response', status: 400, path: '/refused' },
    { name: 'the unauthenticated health response', status: 503, path: '/health', init: { headers: { Authorization: '' } } },
    { name: 'the plain-text 404', status: 404, path: '/missing' },
    { name: 'an auth failure with no token', status: 401, path: '/json', init: { headers: { Authorization: '' } } },
    { name: 'an auth failure with a bad token', status: 401, path: '/json', init: { headers: { Authorization: 'Bearer garbage' } } },
    { name: 'the restricted plain-HTTP refusal', status: 403, path: '/json', overrides: { restrictedPlainHttp: true } },
    { name: 'a failed WebSocket upgrade', status: 426, path: '/exec/abc', init: { headers: { upgrade: 'websocket' } } },
    { name: 'a route that throws', status: 500, path: '/boom' },
    { name: 'a route that rejects', status: 500, path: '/reject' },
    {
      name: 'an authenticator that throws',
      status: 500,
      path: '/json',
      overrides: { authenticate: () => Promise.reject(new Error('auth exploded')) },
    },
    { name: 'an SSE stream', status: 200, path: '/stream' },
  ];

  it.each(paths)('is on $name', async ({ status, path, init, overrides }) => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    const { send } = await harness(overrides);
    const response = await send(path, init);
    errorSpy.mockRestore();
    expect(response.status).toBe(status);
    expect(response.headers.get(AGENT_IDENTITY_HEADER)).toBe(PROTOCOL);
    await response.body?.cancel();
  });

  it('is found under any letter case', async () => {
    const { send } = await harness();
    const response = await send('/json');
    expect(response.headers.get('x-homelab-agent')).toBe(PROTOCOL);
    expect(response.headers.has('X-HOMELAB-AGENT')).toBe(true);
  });

  it('is on the upgrade response of a successful exec WebSocket upgrade', async () => {
    const { send } = await harness();
    const upgrade = mock(() => true);
    const response = await send('/exec/abc?shell=sh&cols=100&rows=30', { headers: { upgrade: 'websocket' } }, { upgrade });
    expect(response).toBeUndefined();
    expect(upgrade).toHaveBeenCalledWith(expect.anything(), {
      data: { containerId: 'abc', shell: 'sh', cols: 100, rows: 30 },
      headers: { [AGENT_IDENTITY_HEADER]: PROTOCOL },
    });
  });

  it('leaves an exec-shaped path to the router when Docker is not configured', async () => {
    const { send } = await harness({ dockerAvailable: false });
    const response = await send('/exec/abc', { headers: { upgrade: 'websocket' } });
    expect(response.status).toBe(404);
    expect(response.headers.get(AGENT_IDENTITY_HEADER)).toBe(PROTOCOL);
  });

  it('does not replace an agent body with anything of its own', async () => {
    const { send } = await harness();
    expect(await (await send('/json')).json()).toEqual({ ok: true });
    expect(await (await send('/missing')).text()).toBe('Not Found');
  });

  it('sends the protocol number alone on the unauthenticated /health and on a 401, never the agent version', async () => {
    const previous = process.env.AGENT_VERSION;
    process.env.AGENT_VERSION = '9.9.9-secret';
    try {
      const { handler } = await harness();
      const health = await handler(requestTo('/health', {}), noUpgrade);
      const unauthorized = await handler(requestTo('/json', {}), noUpgrade);

      expect([health.status, unauthorized.status]).toEqual([503, 401]);
      for (const response of [health, unauthorized]) {
        expect(response.headers.get(AGENT_IDENTITY_HEADER)).toBe('1');
        expect([...response.headers.values()].join('\n')).not.toContain('9.9.9');
      }
    } finally {
      if (previous === undefined) delete process.env.AGENT_VERSION;
      else process.env.AGENT_VERSION = previous;
    }
  });
});

import { describe, it, expect } from 'bun:test';
import { OidcClient } from '../oidc-client';
import type { OidcConfig } from '../oidc-client';

// Bun's `typeof fetch` includes a `preconnect` property that arrow functions lack.
// Cast helpers through `unknown` to satisfy the type constraint.
type FetchFn = typeof fetch;
function asFetch(fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): FetchFn {
  return fn as unknown as FetchFn;
}

const DISCOVERY_URL = 'https://auth.example.com/.well-known/openid-configuration';

const DISCOVERY_BODY = {
  authorization_endpoint: 'https://auth.example.com/authorize',
  token_endpoint: 'https://auth.example.com/token',
  userinfo_endpoint: 'https://auth.example.com/userinfo',
};

const config: OidcConfig = {
  issuerUrl: 'https://auth.example.com',
  clientId: 'my-client',
  clientSecret: 'my-secret',
  redirectUri: 'https://app.example.com/callback',
};

function makeResponse(body: unknown, status = 200): Response {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(bodyStr, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeDiscoveryFetch(extraHandlers?: Record<string, () => Response>): FetchFn {
  return asFetch(async (input, init) => {
    void init;
    const url = input.toString();

    if (url === DISCOVERY_URL) {
      return makeResponse(DISCOVERY_BODY);
    }

    if (extraHandlers?.[url]) {
      return extraHandlers[url]();
    }

    return makeResponse({ error: 'not_found' }, 404);
  });
}

describe('OidcClient', () => {
  describe('discoverEndpoints', () => {
    it('fetches .well-known/openid-configuration and returns endpoints', async () => {
      const client = new OidcClient(config, makeDiscoveryFetch());
      const endpoints = await client.discoverEndpoints();

      expect(endpoints.authorizationEndpoint).toBe('https://auth.example.com/authorize');
      expect(endpoints.tokenEndpoint).toBe('https://auth.example.com/token');
      expect(endpoints.userinfoEndpoint).toBe('https://auth.example.com/userinfo');
    });

    it('caches result so fetch is only called once on repeated calls', async () => {
      let callCount = 0;
      const countingFetch = asFetch(async (input) => {
        if (input.toString() === DISCOVERY_URL) {
          callCount++;
          return makeResponse(DISCOVERY_BODY);
        }
        return makeResponse({}, 404);
      });

      const client = new OidcClient(config, countingFetch);
      await client.discoverEndpoints();
      await client.discoverEndpoints();
      await client.discoverEndpoints();

      expect(callCount).toBe(1);
    });

    it('throws on network error (non-ok response)', async () => {
      const failingFetch = asFetch(async () => makeResponse('Service Unavailable', 503));

      const client = new OidcClient(config, failingFetch);
      await expect(client.discoverEndpoints()).rejects.toThrow('OIDC discovery failed (HTTP 503)');
    });

    it('throws when discovery response is missing required endpoint fields', async () => {
      const missingFetch = asFetch(async () =>
        makeResponse({ authorization_endpoint: 'https://auth.example.com/authorize' }),
      );

      const client = new OidcClient(config, missingFetch);
      await expect(client.discoverEndpoints()).rejects.toThrow(
        'OIDC discovery response missing required endpoints (authorization_endpoint, token_endpoint, userinfo_endpoint)',
      );
    });

    it('throws when discovery response has non-string endpoint fields', async () => {
      const badFetch = asFetch(async () =>
        makeResponse({
          authorization_endpoint: 42,
          token_endpoint: 'https://auth.example.com/token',
          userinfo_endpoint: 'https://auth.example.com/userinfo',
        }),
      );

      const client = new OidcClient(config, badFetch);
      await expect(client.discoverEndpoints()).rejects.toThrow(
        'OIDC discovery response missing required endpoints (authorization_endpoint, token_endpoint, userinfo_endpoint)',
      );
    });
  });

  describe('getAuthorizationUrl', () => {
    it('builds correct URL with required params', async () => {
      const client = new OidcClient(config, makeDiscoveryFetch());
      const url = await client.getAuthorizationUrl('state-abc', 'nonce-xyz');

      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe('https://auth.example.com/authorize');
      expect(parsed.searchParams.get('client_id')).toBe('my-client');
      expect(parsed.searchParams.get('redirect_uri')).toBe('https://app.example.com/callback');
      expect(parsed.searchParams.get('response_type')).toBe('code');
      expect(parsed.searchParams.get('scope')).toBe('openid profile email groups');
      expect(parsed.searchParams.get('state')).toBe('state-abc');
      expect(parsed.searchParams.get('nonce')).toBe('nonce-xyz');
    });

    it('does not include prompt param when not specified', async () => {
      const client = new OidcClient(config, makeDiscoveryFetch());
      const url = await client.getAuthorizationUrl('s', 'n');

      expect(new URL(url).searchParams.has('prompt')).toBe(false);
    });

    it('includes prompt=none for silent re-auth', async () => {
      const client = new OidcClient(config, makeDiscoveryFetch());
      const url = await client.getAuthorizationUrl('state-abc', 'nonce-xyz', 'none');

      expect(new URL(url).searchParams.get('prompt')).toBe('none');
    });
  });

  describe('exchangeCode', () => {
    const TOKEN_RESPONSE = {
      access_token: 'access-tok',
      refresh_token: 'refresh-tok',
      id_token: 'header.e30K.sig',
    };

    it('calls token endpoint with correct params and returns tokens', async () => {
      let capturedInit: RequestInit | undefined;

      const mockFetch = asFetch(async (input, init) => {
        const url = input.toString();
        if (url === DISCOVERY_URL) return makeResponse(DISCOVERY_BODY);
        if (url === 'https://auth.example.com/token') {
          capturedInit = init;
          return makeResponse(TOKEN_RESPONSE);
        }
        return makeResponse({}, 404);
      });

      const client = new OidcClient(config, mockFetch);
      const tokens = await client.exchangeCode('auth-code-123');

      expect(tokens.accessToken).toBe('access-tok');
      expect(tokens.refreshToken).toBe('refresh-tok');
      expect(tokens.idToken).toBe('header.e30K.sig');

      expect(capturedInit?.method).toBe('POST');
      expect((capturedInit?.headers as Record<string, string>)['Content-Type']).toBe(
        'application/x-www-form-urlencoded',
      );

      const body = new URLSearchParams(capturedInit?.body as string);
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('client_id')).toBe('my-client');
      expect(body.get('client_secret')).toBe('my-secret');
      expect(body.get('redirect_uri')).toBe('https://app.example.com/callback');
      expect(body.get('code')).toBe('auth-code-123');
    });

    it('sets refreshToken to null when not present in response', async () => {
      const mockFetch = makeDiscoveryFetch({
        'https://auth.example.com/token': () =>
          makeResponse({ access_token: 'at', id_token: 'it' }),
      });

      const client = new OidcClient(config, mockFetch);
      const tokens = await client.exchangeCode('code');

      expect(tokens.refreshToken).toBeNull();
    });

    it('throws on error response', async () => {
      const mockFetch = makeDiscoveryFetch({
        'https://auth.example.com/token': () => new Response('invalid_grant', { status: 400 }),
      });

      const client = new OidcClient(config, mockFetch);
      await expect(client.exchangeCode('bad-code')).rejects.toThrow(
        'OIDC token exchange failed (HTTP 400): invalid_grant',
      );
    });

    it('throws when token response is missing access_token or id_token', async () => {
      const mockFetch = makeDiscoveryFetch({
        'https://auth.example.com/token': () =>
          makeResponse({ access_token: 'at' /* no id_token */ }),
      });

      const client = new OidcClient(config, mockFetch);
      await expect(client.exchangeCode('code')).rejects.toThrow(
        'OIDC token response missing required fields (access_token, id_token)',
      );
    });

    it('throws when token response fields are not strings', async () => {
      const mockFetch = makeDiscoveryFetch({
        'https://auth.example.com/token': () =>
          makeResponse({ access_token: 123, id_token: true }),
      });

      const client = new OidcClient(config, mockFetch);
      await expect(client.exchangeCode('code')).rejects.toThrow(
        'OIDC token response missing required fields (access_token, id_token)',
      );
    });
  });

  describe('getUserGroups', () => {
    it('fetches userinfo and returns groups claim', async () => {
      const mockFetch = makeDiscoveryFetch({
        'https://auth.example.com/userinfo': () =>
          makeResponse({ sub: 'user1', groups: ['admins', 'developers'] }),
      });

      const client = new OidcClient(config, mockFetch);
      const groups = await client.getUserGroups('my-access-token');

      expect(groups).toEqual(['admins', 'developers']);
    });

    it('returns empty array when groups claim is absent', async () => {
      const mockFetch = makeDiscoveryFetch({
        'https://auth.example.com/userinfo': () =>
          makeResponse({ sub: 'user1', email: 'user@example.com' }),
      });

      const client = new OidcClient(config, mockFetch);
      const groups = await client.getUserGroups('my-access-token');

      expect(groups).toEqual([]);
    });

    it('returns empty array when groups claim is not an array', async () => {
      const mockFetch = makeDiscoveryFetch({
        'https://auth.example.com/userinfo': () =>
          makeResponse({ sub: 'user1', groups: 'admins' }),
      });

      const client = new OidcClient(config, mockFetch);
      const groups = await client.getUserGroups('my-access-token');

      expect(groups).toEqual([]);
    });

    it('returns empty array on non-ok userinfo response', async () => {
      const mockFetch = makeDiscoveryFetch({
        'https://auth.example.com/userinfo': () => makeResponse({ error: 'unauthorized' }, 401),
      });

      const client = new OidcClient(config, mockFetch);
      const groups = await client.getUserGroups('expired-token');

      expect(groups).toEqual([]);
    });

    it('sends Authorization: Bearer header', async () => {
      let capturedHeaders: HeadersInit | undefined;

      const mockFetch = asFetch(async (input, init) => {
        const url = input.toString();
        if (url === DISCOVERY_URL) return makeResponse(DISCOVERY_BODY);
        if (url === 'https://auth.example.com/userinfo') {
          capturedHeaders = init?.headers;
          return makeResponse({ groups: [] });
        }
        return makeResponse({}, 404);
      });

      const client = new OidcClient(config, mockFetch);
      await client.getUserGroups('tok-abc');

      expect((capturedHeaders as Record<string, string>)['Authorization']).toBe('Bearer tok-abc');
    });
  });

  describe('extractIdTokenClaims', () => {
    it('decodes JWT payload without verification', () => {
      const payload = { sub: 'user-123', email: 'user@example.com', nonce: 'abc' };
      const encoded = btoa(JSON.stringify(payload));
      const idToken = `header.${encoded}.signature`;

      const claims = OidcClient.extractIdTokenClaims(idToken);

      expect(claims['sub']).toBe('user-123');
      expect(claims['email']).toBe('user@example.com');
      expect(claims['nonce']).toBe('abc');
    });

    it('throws on invalid JWT format (fewer than 3 parts)', () => {
      expect(() => OidcClient.extractIdTokenClaims('header.payload')).toThrow(
        'Invalid ID token format',
      );
    });

    it('throws on invalid JWT format (more than 3 parts)', () => {
      expect(() => OidcClient.extractIdTokenClaims('a.b.c.d')).toThrow('Invalid ID token format');
    });
  });
});

describe('OidcClient discovery isolation', () => {
  it('each instance has its own endpoint cache', async () => {
    let callCount = 0;
    const countingFetch = asFetch(async () => {
      callCount++;
      return makeResponse(DISCOVERY_BODY);
    });

    const client1 = new OidcClient(config, countingFetch);
    const client2 = new OidcClient(config, countingFetch);

    await client1.discoverEndpoints();
    await client2.discoverEndpoints();

    // Each instance fetches once independently
    expect(callCount).toBe(2);
  });
});

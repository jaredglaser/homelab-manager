import { describe, it, expect, afterEach } from 'bun:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { OidcClient } from '@/lib/auth/oidc-client';
import type { OidcConfig } from '@/lib/auth/oidc-client';

// Bun's `typeof fetch` includes a `preconnect` property that arrow functions lack.
// Cast helpers through `unknown` to satisfy the type constraint.
type FetchFn = typeof fetch;
function asFetch(fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): FetchFn {
  return fn as unknown as FetchFn;
}

const DISCOVERY_URL = 'https://auth.example.com/.well-known/openid-configuration';

const JWKS_URL = 'https://auth.example.com/jwks';

const DISCOVERY_BODY = {
  issuer: 'https://auth.example.com',
  authorization_endpoint: 'https://auth.example.com/authorize',
  token_endpoint: 'https://auth.example.com/token',
  userinfo_endpoint: 'https://auth.example.com/userinfo',
  jwks_uri: JWKS_URL,
};

const DISCOVERY_BODY_WITH_END_SESSION = {
  ...DISCOVERY_BODY,
  end_session_endpoint: 'https://auth.example.com/logout',
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
  describe('fetchWithTimeout (timeout callback)', () => {
    const origSetTimeout = globalThis.setTimeout;

    afterEach(() => {
      globalThis.setTimeout = origSetTimeout;
    });

    it('aborts the request when the timeout fires', async () => {
      let capturedCallback: (() => void) | null = null;
      // Capture the timeout callback without scheduling it
      globalThis.setTimeout = ((fn: () => void) =>
        ((capturedCallback = fn), 0)) as typeof globalThis.setTimeout;

      // A fetch that rejects only when the AbortSignal fires
      const hangingFetch = asFetch((_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
      );

      const client = new OidcClient(config, hangingFetch);
      const promise = client.discoverEndpoints();

      // Fire the captured timeout callback — calls controller.abort()
      capturedCallback!();

      await expect(promise).rejects.toThrow();
    });
  });

  describe('discoverEndpoints', () => {
    it('fetches .well-known/openid-configuration and returns endpoints', async () => {
      const client = new OidcClient(config, makeDiscoveryFetch());
      const endpoints = await client.discoverEndpoints();

      expect(endpoints.authorizationEndpoint).toBe('https://auth.example.com/authorize');
      expect(endpoints.tokenEndpoint).toBe('https://auth.example.com/token');
      expect(endpoints.userinfoEndpoint).toBe('https://auth.example.com/userinfo');
      expect(endpoints.endSessionEndpoint).toBeNull();
    });

    it('captures end_session_endpoint when present in discovery document', async () => {
      const fetchFn = asFetch(async (input) => {
        if (input.toString() === DISCOVERY_URL) return makeResponse(DISCOVERY_BODY_WITH_END_SESSION);
        return makeResponse({}, 404);
      });
      const client = new OidcClient(config, fetchFn);
      const endpoints = await client.discoverEndpoints();

      expect(endpoints.endSessionEndpoint).toBe('https://auth.example.com/logout');
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
        'OIDC discovery response missing required fields (issuer, authorization_endpoint, token_endpoint, userinfo_endpoint, jwks_uri)',
      );
    });

    it('throws when discovery response is missing jwks_uri', async () => {
      const { jwks_uri: _omitted, ...withoutJwks } = DISCOVERY_BODY;
      const missingFetch = asFetch(async () => makeResponse(withoutJwks));

      const client = new OidcClient(config, missingFetch);
      await expect(client.discoverEndpoints()).rejects.toThrow(
        'OIDC discovery response missing required fields (issuer, authorization_endpoint, token_endpoint, userinfo_endpoint, jwks_uri)',
      );
    });

    it('throws when discovery response has non-string endpoint fields', async () => {
      const badFetch = asFetch(async () =>
        makeResponse({ ...DISCOVERY_BODY, authorization_endpoint: 42 }),
      );

      const client = new OidcClient(config, badFetch);
      await expect(client.discoverEndpoints()).rejects.toThrow(
        'OIDC discovery response missing required fields (issuer, authorization_endpoint, token_endpoint, userinfo_endpoint, jwks_uri)',
      );
    });
  });

  describe('getAuthorizationUrl', () => {
    it('builds correct URL with required params', async () => {
      const client = new OidcClient(config, makeDiscoveryFetch());
      const url = await client.getAuthorizationUrl('state-abc', 'nonce-xyz', 'challenge-123');

      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe('https://auth.example.com/authorize');
      expect(parsed.searchParams.get('client_id')).toBe('my-client');
      expect(parsed.searchParams.get('redirect_uri')).toBe('https://app.example.com/callback');
      expect(parsed.searchParams.get('response_type')).toBe('code');
      expect(parsed.searchParams.get('scope')).toBe('openid profile email groups');
      expect(parsed.searchParams.get('state')).toBe('state-abc');
      expect(parsed.searchParams.get('nonce')).toBe('nonce-xyz');
    });

    it('includes PKCE code_challenge and code_challenge_method=S256', async () => {
      const client = new OidcClient(config, makeDiscoveryFetch());
      const url = await client.getAuthorizationUrl('state-abc', 'nonce-xyz', 'challenge-123');

      const parsed = new URL(url);
      expect(parsed.searchParams.get('code_challenge')).toBe('challenge-123');
      expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    });

    it('does not include prompt param when not specified', async () => {
      const client = new OidcClient(config, makeDiscoveryFetch());
      const url = await client.getAuthorizationUrl('s', 'n', 'c');

      expect(new URL(url).searchParams.has('prompt')).toBe(false);
    });

    it('includes prompt=none for silent re-auth', async () => {
      const client = new OidcClient(config, makeDiscoveryFetch());
      const url = await client.getAuthorizationUrl('state-abc', 'nonce-xyz', 'challenge-123', 'none');

      expect(new URL(url).searchParams.get('prompt')).toBe('none');
    });
  });

  describe('getLogoutUrl', () => {
    it('returns end_session_endpoint URL with post_logout_redirect_uri when advertised', async () => {
      const fetchFn = asFetch(async (input) => {
        if (input.toString() === DISCOVERY_URL) return makeResponse(DISCOVERY_BODY_WITH_END_SESSION);
        return makeResponse({}, 404);
      });
      const client = new OidcClient(config, fetchFn);
      const url = await client.getLogoutUrl('https://app.example.com/login');

      const parsed = new URL(url!);
      expect(parsed.origin + parsed.pathname).toBe('https://auth.example.com/logout');
      expect(parsed.searchParams.get('post_logout_redirect_uri')).toBe('https://app.example.com/login');
      expect(parsed.searchParams.has('id_token_hint')).toBe(false);
    });

    it('includes id_token_hint when provided', async () => {
      const fetchFn = asFetch(async (input) => {
        if (input.toString() === DISCOVERY_URL) return makeResponse(DISCOVERY_BODY_WITH_END_SESSION);
        return makeResponse({}, 404);
      });
      const client = new OidcClient(config, fetchFn);
      const url = await client.getLogoutUrl('https://app.example.com/login', 'my-id-token');

      expect(new URL(url!).searchParams.get('id_token_hint')).toBe('my-id-token');
    });

    it('returns null when provider has no end_session_endpoint', async () => {
      const client = new OidcClient(config, makeDiscoveryFetch());
      const url = await client.getLogoutUrl('https://app.example.com/login');
      expect(url).toBeNull();
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
      const tokens = await client.exchangeCode('auth-code-123', 'verifier-456');

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
      expect(body.get('code_verifier')).toBe('verifier-456');
    });

    it('sets refreshToken to null when not present in response', async () => {
      const mockFetch = makeDiscoveryFetch({
        'https://auth.example.com/token': () =>
          makeResponse({ access_token: 'at', id_token: 'it' }),
      });

      const client = new OidcClient(config, mockFetch);
      const tokens = await client.exchangeCode('code', 'verifier');

      expect(tokens.refreshToken).toBeNull();
    });

    it('throws on error response', async () => {
      const mockFetch = makeDiscoveryFetch({
        'https://auth.example.com/token': () => new Response('invalid_grant', { status: 400 }),
      });

      const client = new OidcClient(config, mockFetch);
      await expect(client.exchangeCode('bad-code', 'verifier')).rejects.toThrow(
        'OIDC token exchange failed (HTTP 400): invalid_grant',
      );
    });

    it('throws when token response is missing access_token or id_token', async () => {
      const mockFetch = makeDiscoveryFetch({
        'https://auth.example.com/token': () =>
          makeResponse({ access_token: 'at' /* no id_token */ }),
      });

      const client = new OidcClient(config, mockFetch);
      await expect(client.exchangeCode('code', 'verifier')).rejects.toThrow(
        'OIDC token response missing required fields (access_token, id_token)',
      );
    });

    it('throws when token response fields are not strings', async () => {
      const mockFetch = makeDiscoveryFetch({
        'https://auth.example.com/token': () =>
          makeResponse({ access_token: 123, id_token: true }),
      });

      const client = new OidcClient(config, mockFetch);
      await expect(client.exchangeCode('code', 'verifier')).rejects.toThrow(
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

    it('throws on non-ok userinfo response', async () => {
      const mockFetch = makeDiscoveryFetch({
        'https://auth.example.com/userinfo': () => makeResponse({ error: 'unauthorized' }, 401),
      });

      const client = new OidcClient(config, mockFetch);
      await expect(client.getUserGroups('expired-token')).rejects.toThrow(
        'Userinfo endpoint returned HTTP 401',
      );
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

  describe('verifyIdToken', () => {
    interface SigningSetup {
      client: OidcClient;
      privateKey: CryptoKey;
      jwksFetchCount: () => number;
    }

    async function makeSigningSetup(advertisedAlgs?: string[]): Promise<SigningSetup> {
      const { privateKey, publicKey } = await generateKeyPair('ES256');
      const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' };

      const discovery =
        advertisedAlgs === undefined
          ? DISCOVERY_BODY
          : { ...DISCOVERY_BODY, id_token_signing_alg_values_supported: advertisedAlgs };

      let jwksFetches = 0;
      const fetchFn = asFetch(async (input) => {
        const url = input.toString();
        if (url === DISCOVERY_URL) return makeResponse(discovery);
        if (url === JWKS_URL) {
          jwksFetches++;
          return makeResponse({ keys: [jwk] });
        }
        return makeResponse({}, 404);
      });

      return {
        client: new OidcClient(config, fetchFn),
        privateKey,
        jwksFetchCount: () => jwksFetches,
      };
    }

    function signIdToken(
      privateKey: CryptoKey,
      claims: Record<string, unknown>,
      overrides?: { issuer?: string; audience?: string },
    ): Promise<string> {
      return new SignJWT(claims)
        .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
        .setIssuer(overrides?.issuer ?? 'https://auth.example.com')
        .setAudience(overrides?.audience ?? 'my-client')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
    }

    it('returns claims for a token signed by the provider key', async () => {
      const { client, privateKey } = await makeSigningSetup(['ES256']);
      const idToken = await signIdToken(privateKey, {
        sub: 'user-123',
        email: 'user@example.com',
        nonce: 'abc',
      });

      const claims = await client.verifyIdToken(idToken);

      expect(claims['sub']).toBe('user-123');
      expect(claims['email']).toBe('user@example.com');
      expect(claims['nonce']).toBe('abc');
      expect(claims['iss']).toBe('https://auth.example.com');
      expect(claims['aud']).toBe('my-client');
    });

    it('rejects a token signed by a different key', async () => {
      const { client } = await makeSigningSetup(['ES256']);
      const { privateKey: attackerKey } = await generateKeyPair('ES256');
      const forged = await signIdToken(attackerKey, { sub: 'user-123' });

      await expect(client.verifyIdToken(forged)).rejects.toThrow();
    });

    it('rejects a token with the wrong issuer', async () => {
      const { client, privateKey } = await makeSigningSetup(['ES256']);
      const idToken = await signIdToken(
        privateKey,
        { sub: 'user-123' },
        { issuer: 'https://evil.example.com' },
      );

      await expect(client.verifyIdToken(idToken)).rejects.toThrow();
    });

    it('rejects a token with the wrong audience', async () => {
      const { client, privateKey } = await makeSigningSetup(['ES256']);
      const idToken = await signIdToken(
        privateKey,
        { sub: 'user-123' },
        { audience: 'other-client' },
      );

      await expect(client.verifyIdToken(idToken)).rejects.toThrow();
    });

    it('rejects a token whose alg is not advertised by the provider', async () => {
      const { client, privateKey } = await makeSigningSetup(['RS256']);
      const idToken = await signIdToken(privateKey, { sub: 'user-123' });

      await expect(client.verifyIdToken(idToken)).rejects.toThrow();
    });

    it('defaults to RS256 when the provider advertises no signing algs', async () => {
      const { client, privateKey } = await makeSigningSetup();
      const idToken = await signIdToken(privateKey, { sub: 'user-123' });

      // ES256-signed token rejected because only the RS256 default is allowed
      await expect(client.verifyIdToken(idToken)).rejects.toThrow();
    });

    it('never accepts alg "none" even when advertised', async () => {
      const { client } = await makeSigningSetup(['none']);
      const header = btoa(JSON.stringify({ alg: 'none' })).replace(/=+$/, '');
      const payload = btoa(
        JSON.stringify({
          sub: 'user-123',
          iss: 'https://auth.example.com',
          aud: 'my-client',
          exp: Math.floor(Date.now() / 1000) + 300,
        }),
      ).replace(/=+$/, '');
      const unsigned = `${header}.${payload}.`;

      await expect(client.verifyIdToken(unsigned)).rejects.toThrow();
    });

    it('caches the remote JWK set across verifications', async () => {
      const { client, privateKey, jwksFetchCount } = await makeSigningSetup(['ES256']);
      const first = await signIdToken(privateKey, { sub: 'user-1' });
      const second = await signIdToken(privateKey, { sub: 'user-2' });

      await client.verifyIdToken(first);
      await client.verifyIdToken(second);

      expect(jwksFetchCount()).toBe(1);
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

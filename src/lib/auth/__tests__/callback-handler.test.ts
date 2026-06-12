import { describe, it, expect, mock, afterEach } from 'bun:test';
import {
  handleCallback,
  buildSessionCookie,
  CLEAR_STATE_COOKIE,
  callbackGetHandler,
} from '@/lib/auth/callback-handler';
import type { CallbackHandlerDeps } from '@/lib/auth/callback-handler';
import type { OidcTokens, Role } from '@/lib/auth/types';
import type { UserRow } from '@/lib/database/repositories/user-repository';

const validState = 'state-abc123';
const validNonce = 'nonce-xyz789';
const validCodeVerifier = 'verifier-pqr456';

function makeTokens(overrides?: Partial<OidcTokens>): OidcTokens {
  return {
    accessToken: 'access-token-abc',
    refreshToken: 'refresh-token-xyz',
    idToken: 'eyJhbGciOiJSUzI1NiJ9.test.sig',
    ...overrides,
  };
}

function makeUser(overrides?: Partial<UserRow>): UserRow {
  return {
    id: 42,
    oidcSubject: 'sub-123',
    email: 'alice@example.com',
    name: 'Alice',
    role: 'viewer',
    oidcGroups: ['homelab-viewers'],
    lastLogin: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeIdTokenClaims(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    sub: 'sub-123',
    email: 'alice@example.com',
    name: 'Alice',
    groups: [],
    nonce: validNonce,
    ...overrides,
  };
}

function encodedStateParam(state: string, nonce: string, codeVerifier: string = validCodeVerifier): string {
  return encodeURIComponent(JSON.stringify({ state, nonce, codeVerifier }));
}

function makeDeps(overrides?: Partial<CallbackHandlerDeps>): CallbackHandlerDeps {
  return {
    oidcClient: {
      exchangeCode: mock(async () => makeTokens()),
      getUserGroups: mock(async () => ['homelab-viewers']),
    },
    extractIdTokenClaims: mock(() => makeIdTokenClaims()),
    mapGroupsToRole: mock(() => 'viewer' as Role | null),
    userRepo: {
      upsertFromOidc: mock(async () => makeUser()),
    },
    sessionManager: {
      createSession: mock(async () => 'raw-session-token-abc'),
    },
    roleMapping: {
      admin: 'homelab-admins',
      operator: 'homelab-operators',
      viewer: 'homelab-viewers',
    },
    isSecure: false,
    ...overrides,
  };
}

function validCookieHeader(): string {
  return `oidc_state=${encodedStateParam(validState, validNonce)}`;
}

describe('handleCallback', () => {
  describe('request validation', () => {
    it('returns 400 when state cookie is missing', async () => {
      const deps = makeDeps();
      const response = await handleCallback(
        deps,
        'auth-code',
        validState,
        '',
        null,
        null,
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('Missing state cookie');
    });

    it('returns 400 when state cookie is not valid JSON', async () => {
      const deps = makeDeps();
      const response = await handleCallback(
        deps,
        'auth-code',
        validState,
        'oidc_state=%7Bnot-valid-json%7D',
        null,
        null,
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('Invalid state cookie');
    });

    it('returns 400 when state parameter does not match cookie', async () => {
      const deps = makeDeps();
      const response = await handleCallback(
        deps,
        'auth-code',
        'different-state',
        validCookieHeader(),
        null,
        null,
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('State mismatch');
    });

    it('extracts state cookie correctly when multiple cookies are present', async () => {
      const deps = makeDeps();
      const cookieHeader = `other=value; oidc_state=${encodedStateParam(validState, validNonce)}; another=abc`;
      const response = await handleCallback(
        deps,
        'auth-code',
        validState,
        cookieHeader,
        null,
        null,
      );
      // Valid state — should not be a 400
      expect(response.status).not.toBe(400);
    });

    it('returns 400 when state cookie lacks a PKCE code verifier', async () => {
      const deps = makeDeps();
      const cookieHeader = `oidc_state=${encodeURIComponent(JSON.stringify({ state: validState, nonce: validNonce }))}`;
      const response = await handleCallback(
        deps,
        'auth-code',
        validState,
        cookieHeader,
        null,
        null,
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('State cookie missing code verifier');
      expect(deps.oidcClient.exchangeCode).not.toHaveBeenCalled();
    });

    it('returns 400 when id_token nonce does not match stored nonce', async () => {
      const deps = makeDeps({
        extractIdTokenClaims: mock(() => makeIdTokenClaims({ nonce: 'wrong-nonce' })),
      });
      const response = await handleCallback(
        deps,
        'auth-code',
        validState,
        validCookieHeader(),
        null,
        null,
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('Nonce mismatch');
    });

    it('returns 400 when id_token is missing sub claim', async () => {
      const deps = makeDeps({
        extractIdTokenClaims: mock(() => makeIdTokenClaims({ sub: undefined })),
      });
      const response = await handleCallback(
        deps,
        'auth-code',
        validState,
        validCookieHeader(),
        null,
        null,
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('ID token missing required "sub" claim');
    });

    it('returns 400 when id_token has empty sub claim', async () => {
      const deps = makeDeps({
        extractIdTokenClaims: mock(() => makeIdTokenClaims({ sub: '' })),
      });
      const response = await handleCallback(
        deps,
        'auth-code',
        validState,
        validCookieHeader(),
        null,
        null,
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('ID token missing required "sub" claim');
    });

    it('returns 400 when id_token is missing email claim', async () => {
      const deps = makeDeps({
        extractIdTokenClaims: mock(() => makeIdTokenClaims({ email: undefined })),
      });
      const response = await handleCallback(
        deps,
        'auth-code',
        validState,
        validCookieHeader(),
        null,
        null,
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('ID token missing required "email" claim');
    });

    it('returns 400 when id_token has empty email claim', async () => {
      const deps = makeDeps({
        extractIdTokenClaims: mock(() => makeIdTokenClaims({ email: '' })),
      });
      const response = await handleCallback(
        deps,
        'auth-code',
        validState,
        validCookieHeader(),
        null,
        null,
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('ID token missing required "email" claim');
    });
  });

  describe('role mapping', () => {
    it('redirects to /denied when no role maps to user groups', async () => {
      const deps = makeDeps({
        mapGroupsToRole: mock(() => null),
      });
      const response = await handleCallback(
        deps,
        'auth-code',
        validState,
        validCookieHeader(),
        null,
        null,
      );
      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('/denied');
    });

    it('sets oidc_state clear cookie when redirecting to /denied', async () => {
      const deps = makeDeps({
        mapGroupsToRole: mock(() => null),
      });
      const response = await handleCallback(
        deps,
        'auth-code',
        validState,
        validCookieHeader(),
        null,
        null,
      );
      expect(CLEAR_STATE_COOKIE).toContain('oidc_state=');
      expect(CLEAR_STATE_COOKIE).toContain('Max-Age=0');
      expect(CLEAR_STATE_COOKIE).toContain('Path=/api/auth');
      expect(response.status).toBe(302);
    });
  });

  describe('successful login', () => {
    it('redirects to / on success', async () => {
      const deps = makeDeps();
      const response = await handleCallback(
        deps,
        'auth-code',
        validState,
        validCookieHeader(),
        null,
        null,
      );
      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('/');
    });

    it('does not call sessionManager when role is null', async () => {
      const deps = makeDeps({ mapGroupsToRole: mock(() => null) });
      await handleCallback(deps, 'auth-code', validState, validCookieHeader(), null, null);
      expect(deps.sessionManager.createSession).not.toHaveBeenCalled();
    });

    it('calls sessionManager.createSession on successful auth', async () => {
      const deps = makeDeps();
      await handleCallback(deps, 'auth-code', validState, validCookieHeader(), null, null);
      expect(deps.sessionManager.createSession).toHaveBeenCalledTimes(1);
    });

    it('passes the stored code verifier to exchangeCode', async () => {
      const deps = makeDeps();
      await handleCallback(deps, 'auth-code', validState, validCookieHeader(), null, null);
      expect(deps.oidcClient.exchangeCode).toHaveBeenCalledTimes(1);
      const [code, codeVerifier] = (deps.oidcClient.exchangeCode as ReturnType<typeof mock>).mock
        .calls[0] as [string, string];
      expect(code).toBe('auth-code');
      expect(codeVerifier).toBe(validCodeVerifier);
    });
  });

  describe('buildSessionCookie helper', () => {
    it('includes HttpOnly, SameSite=Lax, and Path=/ for non-secure', () => {
      const cookie = buildSessionCookie('my-raw-token', false);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Path=/');
      expect(cookie).not.toContain('Secure');
    });

    it('includes Secure flag when isSecure=true', () => {
      const cookie = buildSessionCookie('my-raw-token', true);
      expect(cookie).toContain('Secure');
    });

    it('encodes the raw token in the cookie value', () => {
      const token = 'raw/token+value';
      const cookie = buildSessionCookie(token, false);
      expect(cookie).toContain(`session=${encodeURIComponent(token)}`);
    });

    it('starts with session= prefix', () => {
      const cookie = buildSessionCookie('abc', false);
      expect(cookie).toMatch(/^session=/);
    });
  });

  describe('CLEAR_STATE_COOKIE constant', () => {
    it('clears the oidc_state cookie with Max-Age=0', () => {
      expect(CLEAR_STATE_COOKIE).toContain('oidc_state=');
      expect(CLEAR_STATE_COOKIE).toContain('Max-Age=0');
      expect(CLEAR_STATE_COOKIE).toContain('Path=/api/auth');
      expect(CLEAR_STATE_COOKIE).toContain('HttpOnly');
    });
  });

  describe('group merging', () => {
    it('merges groups from userinfo and id_token, deduplicating', async () => {
      const deps = makeDeps({
        oidcClient: {
          exchangeCode: mock(async () => makeTokens()),
          getUserGroups: mock(async () => ['group-a', 'group-b']),
        },
        extractIdTokenClaims: mock(() =>
          makeIdTokenClaims({ groups: ['group-b', 'group-c'] }),
        ),
        mapGroupsToRole: mock((groups: string[]) => {
          if (
            groups.includes('group-a') &&
            groups.includes('group-b') &&
            groups.includes('group-c') &&
            groups.filter((g) => g === 'group-b').length === 1
          ) {
            return 'viewer';
          }
          return null;
        }),
      });

      const response = await handleCallback(
        deps,
        'auth-code',
        validState,
        validCookieHeader(),
        null,
        null,
      );

      expect(deps.mapGroupsToRole).toHaveBeenCalledTimes(1);
      const calledGroups = (deps.mapGroupsToRole as ReturnType<typeof mock>).mock
        .calls[0][0] as string[];
      expect(calledGroups).toContain('group-a');
      expect(calledGroups).toContain('group-b');
      expect(calledGroups).toContain('group-c');
      expect(calledGroups.filter((g) => g === 'group-b')).toHaveLength(1);
      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('/');
    });

    it('handles empty id_token groups gracefully', async () => {
      const deps = makeDeps({
        oidcClient: {
          exchangeCode: mock(async () => makeTokens()),
          getUserGroups: mock(async () => ['homelab-viewers']),
        },
        extractIdTokenClaims: mock(() => makeIdTokenClaims({ groups: undefined })),
      });

      const response = await handleCallback(
        deps,
        'auth-code',
        validState,
        validCookieHeader(),
        null,
        null,
      );

      expect(response.status).toBe(302);
    });
  });

  describe('user upsert', () => {
    it('passes correct user info extracted from id_token claims to upsertFromOidc', async () => {
      const claims = makeIdTokenClaims({
        sub: 'user-subject-456',
        email: 'bob@example.com',
        name: 'Bob Smith',
        groups: [],
      });
      const deps = makeDeps({
        extractIdTokenClaims: mock(() => claims),
        mapGroupsToRole: mock(() => 'admin' as Role | null),
      });

      await handleCallback(deps, 'auth-code', validState, validCookieHeader(), null, null);

      expect(deps.userRepo.upsertFromOidc).toHaveBeenCalledTimes(1);
      const callArg = (deps.userRepo.upsertFromOidc as ReturnType<typeof mock>).mock
        .calls[0][0] as Record<string, unknown>;
      expect(callArg.oidcSubject).toBe('user-subject-456');
      expect(callArg.email).toBe('bob@example.com');
      expect(callArg.name).toBe('Bob Smith');
      expect(callArg.role).toBe('admin');
    });

    it('passes ipAddress and userAgent to createSession', async () => {
      const deps = makeDeps();
      await handleCallback(
        deps,
        'auth-code',
        validState,
        validCookieHeader(),
        '10.0.0.1',
        'TestAgent/1.0',
      );

      expect(deps.sessionManager.createSession).toHaveBeenCalledTimes(1);
      const [, , ipAddress, userAgent] = (
        deps.sessionManager.createSession as ReturnType<typeof mock>
      ).mock.calls[0] as [number, OidcTokens, string | null, string | null];
      expect(ipAddress).toBe('10.0.0.1');
      expect(userAgent).toBe('TestAgent/1.0');
    });
  });
});

function makeRouteRequest(url: string): Request {
  return new Request(url);
}

describe('callbackGetHandler', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('redirects to / when auth is disabled', async () => {
    delete process.env.AUTH_ENABLED;
    const response = await callbackGetHandler({ request: makeRouteRequest('http://localhost/api/auth/callback') });
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/');
  });

  it('returns 400 when code is missing from query params', async () => {
    process.env.AUTH_ENABLED = 'true';
    process.env.OIDC_ISSUER_URL = 'https://pocketid.example.com';
    process.env.OIDC_CLIENT_ID = 'homelab-manager';
    process.env.OIDC_REDIRECT_URI = 'http://localhost:3000/api/auth/callback';
    const response = await callbackGetHandler({ request: makeRouteRequest('http://localhost/api/auth/callback?state=xyz') });
    expect(response.status).toBe(400);
  });

  it('returns 400 when state is missing from query params', async () => {
    process.env.AUTH_ENABLED = 'true';
    process.env.OIDC_ISSUER_URL = 'https://pocketid.example.com';
    process.env.OIDC_CLIENT_ID = 'homelab-manager';
    process.env.OIDC_REDIRECT_URI = 'http://localhost:3000/api/auth/callback';
    const response = await callbackGetHandler({ request: makeRouteRequest('http://localhost/api/auth/callback?code=abc') });
    expect(response.status).toBe(400);
  });

  it('redirects to /login?error=callback_failed when an unhandled error occurs', async () => {
    // AUTH_ENABLED=true, code+state present, but OIDC vars missing -> loadAuthConfig throws -> caught
    process.env.AUTH_ENABLED = 'true';
    delete process.env.OIDC_ISSUER_URL;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_REDIRECT_URI;
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const response = await callbackGetHandler({ request: makeRouteRequest('http://localhost/api/auth/callback?code=abc&state=xyz') });
      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('/login?error=callback_failed');
    } finally {
      console.error = originalConsoleError;
    }
  });
});

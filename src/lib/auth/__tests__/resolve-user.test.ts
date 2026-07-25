import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { resolveUserFromCookie, resetAuthResolverState } from '@/lib/auth/resolve-user';
import { SYNTHETIC_ADMIN } from '@/lib/auth/types';
import type { AuthUser } from '@/lib/auth/types';

let authDisabled = false;
let secureCookie = false;
mock.module('@/lib/config/auth-config', () => ({
  isAuthDisabled: () => authDisabled,
  isSecureCookie: () => secureCookie,
}));

const mockValidateSession = mock(async (_token: string) => null as AuthUser | null);
const mockBuildSessionManager = mock(async () => ({ validateSession: mockValidateSession }));
mock.module('@/lib/auth/session-manager', () => ({
  buildSessionManager: mockBuildSessionManager,
  resetSessionManagerState: () => {},
  // Full shape kept so mock.module leaking into other files still compiles.
  SessionManager: class MockSessionManager {
    constructor() {}
  },
}));

function makeUser(overrides?: Partial<AuthUser>): AuthUser {
  return {
    id: 1,
    email: 'user@example.com',
    name: 'Test User',
    role: 'viewer',
    ...overrides,
  };
}

// new Request() drops cookie headers under Happy-DOM (forbidden-header rules), so fake the shape instead.
function makeRequest(cookieHeader?: string): Request {
  return {
    headers: {
      get: (name: string) => (name === 'cookie' ? (cookieHeader ?? null) : null),
    },
  } as unknown as Request;
}

describe('resolveUserFromCookie', () => {
  beforeEach(() => {
    authDisabled = false;
    secureCookie = false;
    resetAuthResolverState();
    mockValidateSession.mockClear();
    mockBuildSessionManager.mockClear();
  });

  afterEach(() => {
    resetAuthResolverState();
  });

  it('returns SYNTHETIC_ADMIN when auth is disabled, without touching the session manager', async () => {
    authDisabled = true;

    const result = await resolveUserFromCookie(makeRequest('session=whatever'));

    expect(result).toEqual(SYNTHETIC_ADMIN);
    expect(mockBuildSessionManager).not.toHaveBeenCalled();
  });

  it('returns null when no cookie header is present', async () => {
    const result = await resolveUserFromCookie(makeRequest());

    expect(result).toBeNull();
    expect(mockBuildSessionManager).not.toHaveBeenCalled();
  });

  it('returns null when the cookie header has no session cookie', async () => {
    const result = await resolveUserFromCookie(makeRequest('other=abc; foo=bar'));

    expect(result).toBeNull();
    expect(mockBuildSessionManager).not.toHaveBeenCalled();
  });

  it('returns the AuthUser for a valid session token', async () => {
    const user = makeUser({ id: 5, email: 'alice@example.com', role: 'admin' });
    mockValidateSession.mockImplementation(async () => user);

    const result = await resolveUserFromCookie(makeRequest('session=valid-token'));

    expect(result).toEqual(user);
    expect(mockValidateSession).toHaveBeenCalledWith('valid-token');
  });

  it('reads the __Host-session cookie when the deployment is https', async () => {
    secureCookie = true;
    const user = makeUser({ id: 7, email: 'eve@example.com', role: 'admin' });
    mockValidateSession.mockImplementation(async () => user);

    const result = await resolveUserFromCookie(makeRequest('__Host-session=host-token-xyz'));

    expect(result).toEqual(user);
    expect(mockValidateSession).toHaveBeenCalledWith('host-token-xyz');
  });

  it('ignores a plain session cookie when the deployment is https', async () => {
    secureCookie = true;
    mockValidateSession.mockImplementation(async () => makeUser());

    const result = await resolveUserFromCookie(makeRequest('session=planted-token'));

    expect(result).toBeNull();
    expect(mockBuildSessionManager).not.toHaveBeenCalled();
  });

  it('returns null for an expired or invalid session token', async () => {
    mockValidateSession.mockImplementation(async () => null);

    const result = await resolveUserFromCookie(makeRequest('session=expired-token'));

    expect(result).toBeNull();
    expect(mockValidateSession).toHaveBeenCalledWith('expired-token');
  });

  it('URL-decodes and picks the session cookie out of several cookies', async () => {
    const user = makeUser();
    mockValidateSession.mockImplementation(async () => user);

    const result = await resolveUserFromCookie(makeRequest('foo=bar; session=tok-abc; baz=qux'));

    expect(result).toEqual(user);
    expect(mockValidateSession).toHaveBeenCalledWith('tok-abc');
  });

  it('builds the session manager once and reuses it across calls', async () => {
    mockValidateSession.mockImplementation(async () => makeUser());

    await resolveUserFromCookie(makeRequest('session=token-a'));
    await resolveUserFromCookie(makeRequest('session=token-b'));

    expect(mockBuildSessionManager).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the session manager after resetAuthResolverState()', async () => {
    mockValidateSession.mockImplementation(async () => makeUser());

    await resolveUserFromCookie(makeRequest('session=token-a'));
    resetAuthResolverState();
    await resolveUserFromCookie(makeRequest('session=token-b'));

    expect(mockBuildSessionManager).toHaveBeenCalledTimes(2);
  });
});

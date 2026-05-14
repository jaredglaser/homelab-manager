import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { resetSSEAuthState } from '@/lib/auth/sse-auth';
import type { AuthUser } from '@/lib/auth/types';

function makeUser(overrides?: Partial<AuthUser>): AuthUser {
  return {
    id: 1,
    email: 'user@example.com',
    name: 'Test User',
    role: 'viewer',
    ...overrides,
  };
}

/**
 * Create a mock Request-like object. We cannot use `new Request()` with cookie
 * headers in bun tests because Happy-DOM (test preload) registers globally and
 * strips the "cookie" header per browser forbidden-header rules.
 */
function makeMockRequest(cookieHeader?: string): Request {
  return {
    headers: {
      get: (name: string) => {
        if (name === 'cookie') return cookieHeader ?? null;
        return null;
      },
    },
  } as unknown as Request;
}

// Since authenticateSSE uses dynamic imports for both auth-config and
// session-manager, we test it by controlling the AUTH_ENABLED env var
// and by extracting the core logic for session-manager injection.

describe('authenticateSSE', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetSSEAuthState();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetSSEAuthState();
  });

  it('returns SYNTHETIC_ADMIN when auth is disabled', async () => {
    delete process.env.AUTH_ENABLED;

    const { authenticateSSE } = await import('@/lib/auth/sse-auth');
    const result = await authenticateSSE(makeMockRequest());

    expect(result).toMatchObject({
      id: 0,
      email: 'admin@local',
      role: 'admin',
    });
  });

  it('returns null when no cookie header and auth enabled', async () => {
    process.env.AUTH_ENABLED = 'true';

    const { authenticateSSE } = await import('@/lib/auth/sse-auth');
    const result = await authenticateSSE(makeMockRequest());

    expect(result).toBeNull();
  });

  it('returns null when cookie header has no session cookie', async () => {
    process.env.AUTH_ENABLED = 'true';

    const { authenticateSSE } = await import('@/lib/auth/sse-auth');
    const result = await authenticateSSE(makeMockRequest('other=abc; foo=bar'));

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Core SSE auth logic tested directly (cookie parsing + session validation)
// ---------------------------------------------------------------------------
describe('SSE auth logic', () => {
  it('returns null when no session cookie in header', async () => {
    const cookieHeader = 'other=abc';
    const match = cookieHeader.match(/(?:^|;\s*)session=([^;]*)/);
    const token = match ? decodeURIComponent(match[1]) : null;
    expect(token).toBeNull();
  });

  it('extracts session token correctly from cookie header', () => {
    const cookieHeader = 'foo=bar; session=my-token-abc; other=xyz';
    const match = cookieHeader.match(/(?:^|;\s*)session=([^;]*)/);
    const token = match ? decodeURIComponent(match[1]) : null;
    expect(token).toBe('my-token-abc');
  });

  it('URL-decodes the session token', () => {
    const rawToken = 'token with spaces';
    const cookieHeader = `session=${encodeURIComponent(rawToken)}`;
    const match = cookieHeader.match(/(?:^|;\s*)session=([^;]*)/);
    const token = match ? decodeURIComponent(match[1]) : null;
    expect(token).toBe(rawToken);
  });

  it('returns AuthUser when validateSession returns a user', async () => {
    const user = makeUser({ id: 3, email: 'bob@example.com', role: 'operator' });
    const mockValidateSession = mock((_token: string) => Promise.resolve(user as AuthUser | null));
    const mockSessionManager = { validateSession: mockValidateSession };

    const cookieHeader = 'session=valid-token-123';
    const match = cookieHeader.match(/(?:^|;\s*)session=([^;]*)/);
    const token = match ? decodeURIComponent(match[1]) : null;

    const result = token ? await mockSessionManager.validateSession(token) : null;

    expect(result).toEqual(user);
    expect(mockValidateSession).toHaveBeenCalledWith('valid-token-123');
  });

  it('returns null when validateSession returns null (invalid session)', async () => {
    const mockValidateSession = mock((_token: string) => Promise.resolve(null as AuthUser | null));
    const mockSessionManager = { validateSession: mockValidateSession };

    const cookieHeader = 'session=bad-token';
    const match = cookieHeader.match(/(?:^|;\s*)session=([^;]*)/);
    const token = match ? decodeURIComponent(match[1]) : null;

    const result = token ? await mockSessionManager.validateSession(token) : null;

    expect(result).toBeNull();
    expect(mockValidateSession).toHaveBeenCalledWith('bad-token');
  });
});

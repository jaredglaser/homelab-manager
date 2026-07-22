import { describe, it, expect, afterEach } from 'bun:test';

/**
 * Create a mock Request-like object. We cannot use `new Request()` with cookie
 * headers in bun tests because Happy-DOM (test preload) registers globally and
 * strips the "cookie" header per browser forbidden-header rules.
 */
function makeMockRequest(cookieHeader?: string): Request {
  return {
    headers: {
      get: (name: string) => (name === 'cookie' ? (cookieHeader ?? null) : null),
    },
  } as unknown as Request;
}

// authenticateSSE is a thin adapter over resolveUserFromCookie: it passes the
// request through and returns whatever the resolver returns, unchanged. The
// resolution logic itself (cookie parsing, AUTH_DISABLED, session validation)
// is covered by resolve-user.test.ts; these tests only check the pass-through,
// exercised through the real resolver so no mock of '@/lib/auth/resolve-user'
// is needed here (mock.module for that path would otherwise leak across files).
// The module is imported dynamically per test (not statically at the top)
// because several other test files mock '@/lib/auth/sse-auth' wholesale
// (create-broadcast-sse-handler.test.ts, create-stats-sse-handler.test.ts);
// a static import binding here can pick up that mock instead of the real
// module when the whole suite runs together.
describe('authenticateSSE', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns SYNTHETIC_ADMIN when auth is disabled', async () => {
    process.env.AUTH_DISABLED = 'true';
    const { authenticateSSE } = await import('@/lib/auth/sse-auth');

    const result = await authenticateSSE(makeMockRequest());

    expect(result).toMatchObject({
      id: 0,
      email: 'admin@local',
      role: 'admin',
    });
  });

  it('returns null when auth is enabled and no session cookie is present', async () => {
    delete process.env.AUTH_DISABLED;
    const { authenticateSSE } = await import('@/lib/auth/sse-auth');

    const result = await authenticateSSE(makeMockRequest());

    expect(result).toBeNull();
  });

  it('returns null when the cookie header has no session cookie', async () => {
    delete process.env.AUTH_DISABLED;
    const { authenticateSSE } = await import('@/lib/auth/sse-auth');

    const result = await authenticateSSE(makeMockRequest('other=abc; foo=bar'));

    expect(result).toBeNull();
  });
});

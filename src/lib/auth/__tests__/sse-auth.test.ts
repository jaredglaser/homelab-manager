import { describe, it, expect, afterEach } from 'bun:test';

// new Request() drops cookie headers under Happy-DOM (forbidden-header rules), so fake the shape instead.
function makeMockRequest(cookieHeader?: string): Request {
  return {
    headers: {
      get: (name: string) => (name === 'cookie' ? (cookieHeader ?? null) : null),
    },
  } as unknown as Request;
}

// Imported dynamically per test, not statically: other files mock '@/lib/auth/sse-auth' wholesale,
// and a static import here can bind to that mock instead of the real module.
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

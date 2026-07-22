import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';

// getRequest() requires an H3 AsyncLocalStorage context not present in tests;
// mock it to return a controllable request object.
const mockGetRequest = mock(() => ({
  headers: { get: (_name: string) => null as string | null },
}));

mock.module('@tanstack/start-server-core', () => ({
  getRequest: mockGetRequest,
}));

// ---------------------------------------------------------------------------
// AuthError
// ---------------------------------------------------------------------------
describe('AuthError', () => {
  test('has the correct status and message', async () => {
    const { AuthError } = await import('@/middleware/auth-middleware');
    const err = new AuthError(401, 'No session');
    expect(err.status).toBe(401);
    expect(err.message).toBe('No session');
    expect(err).toBeInstanceOf(Error);
  });

  test('name is AuthError', async () => {
    const { AuthError } = await import('@/middleware/auth-middleware');
    const err = new AuthError(401, 'test');
    expect(err.name).toBe('AuthError');
  });
});

// ---------------------------------------------------------------------------
// authMiddleware: a thin adapter over resolveUserFromCookie that throws
// AuthError on a null resolution. The resolution logic itself (cookie
// parsing, AUTH_DISABLED, session validation) is covered by resolve-user.test.ts;
// these tests only check the adapter's throw-on-null mapping, exercised
// through the real resolver so no mock of '@/lib/auth/resolve-user' is
// needed here (mock.module for that path would otherwise leak across files).
// authMiddleware and AuthError are imported dynamically per test (not
// statically at the top) because several other test files mock
// '@/middleware/auth-middleware' wholesale; a static import binding here can
// pick up that mock instead of the real module when the whole suite runs
// together.
// ---------------------------------------------------------------------------
describe('authMiddleware', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockGetRequest.mockClear();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('injects SYNTHETIC_ADMIN into context.user when auth is disabled', async () => {
    process.env.AUTH_DISABLED = 'true';
    const { authMiddleware } = await import('@/middleware/auth-middleware');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serverHandler = (authMiddleware as any).options.server as (args: unknown) => Promise<unknown>;

    let capturedContext: Record<string, unknown> = {};
    const nextFn = mock(({ context }: { context: Record<string, unknown> }) => {
      capturedContext = context;
      return Promise.resolve('next-result');
    });

    await serverHandler({ next: nextFn, context: {} });

    expect(nextFn).toHaveBeenCalledTimes(1);
    expect(capturedContext.user).toMatchObject({
      id: 0,
      email: 'admin@local',
      role: 'admin',
    });
  });

  test('throws AuthError with status 401 when there is no session cookie', async () => {
    delete process.env.AUTH_DISABLED;
    const { authMiddleware, AuthError } = await import('@/middleware/auth-middleware');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serverHandler = (authMiddleware as any).options.server as (args: unknown) => Promise<unknown>;

    const nextFn = mock(() => Promise.resolve());

    try {
      await serverHandler({ next: nextFn, context: {} });
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as InstanceType<typeof AuthError>).status).toBe(401);
    }
    expect(nextFn).not.toHaveBeenCalled();
  });

  test('middleware options have server handler defined', async () => {
    const { authMiddleware } = await import('@/middleware/auth-middleware');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((authMiddleware as any).options).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((authMiddleware as any).options.server).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(typeof (authMiddleware as any).options.server).toBe('function');
  });
});

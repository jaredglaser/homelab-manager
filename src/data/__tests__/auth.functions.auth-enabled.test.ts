import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { SYNTHETIC_ADMIN } from '@/lib/auth/types';
import type { AuthUser } from '@/lib/auth/types';

// Test the auth-enabled paths in auth.functions: sessionReadMiddleware and getRoleMapping.
// A separate file from auth.functions.test.ts is needed because that file mocks
// isAuthDisabled as () => true globally, while these tests need the auth-enabled path.

// getRequest() requires H3 AsyncLocalStorage context; mock it to return a controllable request.
const mockGetRequest = mock(() => ({
  headers: { get: (_name: string) => null as string | null },
}));

mock.module('@tanstack/start-server-core', () => ({
  getRequest: mockGetRequest,
}));

const mockValidateSession = mock(async (_token: string) => null as AuthUser | null);
mock.module('@/lib/auth/session-manager', () => ({
  buildSessionManager: mock(async () => ({ validateSession: mockValidateSession })),
  resetSessionManagerState: () => {},
  SessionManager: class {},
}));

const mockLoadAuthConfig = mock(() => ({
  issuerUrl: 'https://pocketid.example.com',
  clientId: 'homelab-manager',
  redirectUri: 'http://localhost/callback',
  sessionTtlHours: 8,
  roleMapping: { admin: 'my-admins', operator: 'my-ops', viewer: 'my-viewers' },
}));

mock.module('@/lib/config/auth-config', () => ({
  isAuthDisabled: () => false,
  loadAuthConfig: mockLoadAuthConfig,
}));

mock.module('@/middleware/auth-middleware', () => ({
  authMiddleware: {
    options: {
      type: 'function',
      client: async ({ next, sendContext }: { next: (opts: { sendContext: unknown }) => unknown; sendContext: unknown }) => {
        return next({ sendContext: { ...(sendContext as Record<string, unknown>), user: SYNTHETIC_ADMIN } });
      },
      server: async ({ next, context }: { next: (opts: { context: unknown }) => unknown; context: unknown }) => {
        return next({ context: { ...(context as Record<string, unknown>), user: SYNTHETIC_ADMIN } });
      },
    },
  },
  AuthError: class AuthError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'AuthError';
    }
  },
}));

// sessionReadMiddleware is a thin adapter over resolveUserFromCookie: it
// passes the resolver's null/AuthUser result straight through as
// sessionUser, never throwing. These tests exercise it through the real
// resolver (mocking only its dependencies: getRequest and session-manager)
// so no mock.module of '@/lib/auth/resolve-user' is needed here (that would
// leak across files and break resolve-user.test.ts, which needs the real
// module). The resolution logic itself is covered by resolve-user.test.ts.
describe('sessionReadMiddleware (auth enabled)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockGetRequest.mockClear();
    mockValidateSession.mockClear();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('passes sessionUser: null when no session cookie is present', async () => {
    // getRequest() returns headers with get() returning null (no cookie)
    mockGetRequest.mockImplementation(() => ({
      headers: { get: (_name: string) => null as string | null },
    }));

    const { sessionReadMiddleware } = await import('@/data/auth.functions');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serverHandler = (sessionReadMiddleware as any).options.server as (
      args: unknown,
    ) => Promise<unknown>;

    let capturedContext: Record<string, unknown> = {};
    const nextFn = mock(({ context }: { context: Record<string, unknown> }) => {
      capturedContext = context;
      return Promise.resolve('next-result');
    });

    await serverHandler({ next: nextFn, context: {} });

    expect(nextFn).toHaveBeenCalledTimes(1);
    expect(capturedContext.sessionUser).toBeNull();
  });

  it('passes sessionUser: null when session token is invalid', async () => {
    mockGetRequest.mockImplementation(() => ({
      headers: { get: (name: string) => (name === 'cookie' ? 'session=bad-token' : null) },
    }));
    mockValidateSession.mockImplementation(async () => null);

    const { sessionReadMiddleware } = await import('@/data/auth.functions');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serverHandler = (sessionReadMiddleware as any).options.server as (
      args: unknown,
    ) => Promise<unknown>;

    let capturedContext: Record<string, unknown> = {};
    const nextFn = mock(({ context }: { context: Record<string, unknown> }) => {
      capturedContext = context;
      return Promise.resolve();
    });

    await serverHandler({ next: nextFn, context: {} });

    expect(mockValidateSession).toHaveBeenCalledWith('bad-token');
    expect(capturedContext.sessionUser).toBeNull();
  });

  it('passes sessionUser: AuthUser when session token is valid', async () => {
    const user: AuthUser = { id: 1, email: 'alice@example.com', name: 'Alice', role: 'admin' };
    mockGetRequest.mockImplementation(() => ({
      headers: { get: (name: string) => (name === 'cookie' ? 'session=valid-token' : null) },
    }));
    mockValidateSession.mockImplementation(async () => user);

    const { sessionReadMiddleware } = await import('@/data/auth.functions');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serverHandler = (sessionReadMiddleware as any).options.server as (
      args: unknown,
    ) => Promise<unknown>;

    let capturedContext: Record<string, unknown> = {};
    const nextFn = mock(({ context }: { context: Record<string, unknown> }) => {
      capturedContext = context;
      return Promise.resolve();
    });

    await serverHandler({ next: nextFn, context: {} });

    expect(mockValidateSession).toHaveBeenCalledWith('valid-token');
    expect(capturedContext.sessionUser).toEqual(user);
  });
});

describe('getRoleMapping (auth enabled)', () => {
  beforeEach(() => {
    mockLoadAuthConfig.mockClear();
  });

  it('calls loadAuthConfig to read role mapping when auth is enabled', async () => {
    const { getRoleMapping } = await import('@/data/auth.functions');
    await getRoleMapping({});
    // createServerFn() wraps do not return handler values in test context;
    // verify delegation by asserting on mock call counts.
    expect(mockLoadAuthConfig).toHaveBeenCalledTimes(1);
  });
});

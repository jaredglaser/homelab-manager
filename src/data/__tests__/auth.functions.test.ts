import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { createRequire } from 'node:module';
import { SYNTHETIC_ADMIN } from '@/lib/auth/types';
import { withStartContext } from '@/lib/test/start-context';
import { mockModule } from '@/lib/test/mock-module';

// getRequest() requires an H3 AsyncLocalStorage context not present in tests;
// mock it to return a controllable request object.
const mockGetRequest = mock(() => ({
  headers: { get: (_name: string) => null as string | null },
}));

mockModule<typeof import('@tanstack/start-server-core')>('@tanstack/start-server-core', (real) => ({ ...real, 
  getRequest: mockGetRequest,
}));

mockModule<typeof import('@/middleware/auth-middleware')>('@/middleware/auth-middleware', (real) => ({ ...real, 
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

const mockPool = { query: mock(async () => ({ rows: [] })) };
const mockGetClient = mock(async () => ({ getPool: () => mockPool }));

mockModule<typeof import('@/lib/clients/database-client')>('@/lib/clients/database-client', (real) => ({ ...real, 
  databaseConnectionManager: { getClient: mockGetClient },
}));
mockModule<typeof import('@/lib/config/database-config')>('@/lib/config/database-config', (real) => ({ ...real, 
  loadDatabaseConfig: () => ({}),
}));

const mockUserFindAll = mock(async () => [] as unknown[]);
mockModule<typeof import('@/lib/database/repositories/user-repository')>('@/lib/database/repositories/user-repository', (real) => ({ ...real, 
  UserRepository: class MockUserRepository {
    constructor() {}
    findAll = mockUserFindAll;
  },
}));

const mockSessionFindAllWithUser = mock(async () => [] as unknown[]);
const mockSessionDeleteById = mock(async () => {});
const mockSessionDeleteByUserId = mock(async () => {});
mockModule<typeof import('@/lib/database/repositories/session-repository')>('@/lib/database/repositories/session-repository', (real) => ({ ...real, 
  SessionRepository: class MockSessionRepository {
    constructor() {}
    findAllWithUser = mockSessionFindAllWithUser;
    deleteById = mockSessionDeleteById;
    deleteByUserId = mockSessionDeleteByUserId;
  },
}));

// isAuthDisabled: true drives sessionReadMiddleware through the resolver's short-circuit, skipping session-manager mocking.
const authConfigReal = createRequire(import.meta.url)('@/lib/config/auth-config');
mockModule<typeof import('@/lib/config/auth-config')>('@/lib/config/auth-config', (real) => ({ ...real, 
  ...authConfigReal,
  isAuthDisabled: () => true,
}));

// createServerFn() wrappers do not return handler values in test context.
// Tests verify delegation by asserting on mock call counts and arguments.

describe('sessionReadMiddleware (auth disabled)', () => {
  it('passes sessionUser: SYNTHETIC_ADMIN when auth is disabled', async () => {
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

    expect(nextFn).toHaveBeenCalledTimes(1);
    expect(capturedContext.sessionUser).toMatchObject({
      id: 0,
      email: 'admin@local',
      role: 'admin',
    });
  });
});

describe('auth.functions', () => {
  beforeEach(() => {
    mockPool.query.mockClear();
    mockGetClient.mockClear();
    mockUserFindAll.mockClear();
    mockSessionFindAllWithUser.mockClear();
    mockSessionDeleteById.mockClear();
    mockSessionDeleteByUserId.mockClear();
  });

  describe('getSession', () => {
    it('is defined and callable without throwing', async () => {
      const { getSession } = await import('@/data/auth.functions');
      expect(typeof getSession).toBe('function');
      await withStartContext(() => getSession());
    });
  });

  describe('listUsers', () => {
    it('delegates to UserRepository.findAll', async () => {
      const { listUsers } = await import('@/data/auth.functions');
      await withStartContext(() => listUsers({}));
      expect(mockUserFindAll).toHaveBeenCalledTimes(1);
    });

    it('creates a UserRepository using the db pool', async () => {
      const { listUsers } = await import('@/data/auth.functions');
      await withStartContext(() => listUsers({}));
      expect(mockGetClient).toHaveBeenCalledTimes(1);
    });
  });

  describe('listSessions', () => {
    it('delegates to SessionRepository.findAllWithUser', async () => {
      const { listSessions } = await import('@/data/auth.functions');
      await withStartContext(() => listSessions({}));
      expect(mockSessionFindAllWithUser).toHaveBeenCalledTimes(1);
    });

    it('creates a SessionRepository using the db pool', async () => {
      const { listSessions } = await import('@/data/auth.functions');
      await withStartContext(() => listSessions({}));
      expect(mockGetClient).toHaveBeenCalledTimes(1);
    });
  });

  describe('revokeSession', () => {
    it('calls deleteById with the given sessionId', async () => {
      const { revokeSession } = await import('@/data/auth.functions');
      await withStartContext(() => revokeSession({ data: { sessionId: 'abc123' } }));
      expect(mockSessionDeleteById).toHaveBeenCalledTimes(1);
      expect(mockSessionDeleteById).toHaveBeenCalledWith('abc123');
    });

    it('passes a different sessionId through correctly', async () => {
      const { revokeSession } = await import('@/data/auth.functions');
      await withStartContext(() => revokeSession({ data: { sessionId: 'session-xyz' } }));
      expect(mockSessionDeleteById).toHaveBeenCalledWith('session-xyz');
    });
  });

  describe('revokeAllUserSessions', () => {
    it('calls deleteByUserId with the given userId', async () => {
      const { revokeAllUserSessions } = await import('@/data/auth.functions');
      await withStartContext(() => revokeAllUserSessions({ data: { userId: 42 } }));
      expect(mockSessionDeleteByUserId).toHaveBeenCalledTimes(1);
      expect(mockSessionDeleteByUserId).toHaveBeenCalledWith(42);
    });

    it('passes a different userId through correctly', async () => {
      const { revokeAllUserSessions } = await import('@/data/auth.functions');
      await withStartContext(() => revokeAllUserSessions({ data: { userId: 99 } }));
      expect(mockSessionDeleteByUserId).toHaveBeenCalledWith(99);
    });
  });

  describe('getRoleMapping', () => {
    it('is callable without throwing when auth is disabled', async () => {
      const { getRoleMapping } = await import('@/data/auth.functions');
      await withStartContext(() => getRoleMapping({}));
    });
  });
});

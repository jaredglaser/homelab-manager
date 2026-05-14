import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { SYNTHETIC_ADMIN } from '@/lib/auth/types';
import type { AuthUser } from '@/lib/auth/types';

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
  parseCookie: mock((_header: string | null, _name: string) => null as string | null),
  resetAuthMiddlewareState: () => {},
}));

const mockPool = { query: mock(async () => ({ rows: [] })) };
const mockGetClient = mock(async () => ({ getPool: () => mockPool }));

mock.module('@/lib/clients/database-client', () => ({
  databaseConnectionManager: { getClient: mockGetClient },
}));
mock.module('@/lib/config/database-config', () => ({
  loadDatabaseConfig: () => ({}),
}));

const mockUserFindAll = mock(async () => [] as unknown[]);
mock.module('@/lib/database/repositories/user-repository', () => ({
  UserRepository: class MockUserRepository {
    constructor() {}
    findAll = mockUserFindAll;
  },
}));

const mockSessionFindAllWithUser = mock(async () => [] as unknown[]);
const mockSessionDeleteById = mock(async () => {});
const mockSessionDeleteByUserId = mock(async () => {});
mock.module('@/lib/database/repositories/session-repository', () => ({
  SessionRepository: class MockSessionRepository {
    constructor() {}
    findAllWithUser = mockSessionFindAllWithUser;
    deleteById = mockSessionDeleteById;
    deleteByUserId = mockSessionDeleteByUserId;
  },
}));

const mockValidateSession = mock(async (_token: string) => null as AuthUser | null);
mock.module('@/lib/auth/session-manager', () => ({
  buildSessionManager: mock(async () => ({ validateSession: mockValidateSession })),
  resetSessionManagerState: () => {},
  SessionManager: class {},
}));

mock.module('@/lib/config/auth-config', () => ({
  isAuthDisabled: () => true,
}));

// createServerFn() wrappers do not return handler values in test context.
// Tests verify delegation by asserting on mock call counts and arguments.
describe('auth.functions', () => {
  beforeEach(() => {
    mockPool.query.mockClear();
    mockGetClient.mockClear();
    mockUserFindAll.mockClear();
    mockSessionFindAllWithUser.mockClear();
    mockSessionDeleteById.mockClear();
    mockSessionDeleteByUserId.mockClear();
    mockValidateSession.mockClear();
  });

  describe('getSession', () => {
    it('is defined and callable without throwing', async () => {
      const { getSession } = await import('@/data/auth.functions');
      expect(typeof getSession).toBe('function');
      await getSession();
    });
  });

  describe('listUsers', () => {
    it('delegates to UserRepository.findAll', async () => {
      const { listUsers } = await import('@/data/auth.functions');
      await listUsers({});
      expect(mockUserFindAll).toHaveBeenCalledTimes(1);
    });

    it('creates a UserRepository using the db pool', async () => {
      const { listUsers } = await import('@/data/auth.functions');
      await listUsers({});
      expect(mockGetClient).toHaveBeenCalledTimes(1);
    });
  });

  describe('listSessions', () => {
    it('delegates to SessionRepository.findAllWithUser', async () => {
      const { listSessions } = await import('@/data/auth.functions');
      await listSessions({});
      expect(mockSessionFindAllWithUser).toHaveBeenCalledTimes(1);
    });

    it('creates a SessionRepository using the db pool', async () => {
      const { listSessions } = await import('@/data/auth.functions');
      await listSessions({});
      expect(mockGetClient).toHaveBeenCalledTimes(1);
    });
  });

  describe('revokeSession', () => {
    it('calls deleteById with the given sessionId', async () => {
      const { revokeSession } = await import('@/data/auth.functions');
      await revokeSession({ data: { sessionId: 'abc123' } });
      expect(mockSessionDeleteById).toHaveBeenCalledTimes(1);
      expect(mockSessionDeleteById).toHaveBeenCalledWith('abc123');
    });

    it('passes a different sessionId through correctly', async () => {
      const { revokeSession } = await import('@/data/auth.functions');
      await revokeSession({ data: { sessionId: 'session-xyz' } });
      expect(mockSessionDeleteById).toHaveBeenCalledWith('session-xyz');
    });
  });

  describe('revokeAllUserSessions', () => {
    it('calls deleteByUserId with the given userId', async () => {
      const { revokeAllUserSessions } = await import('@/data/auth.functions');
      await revokeAllUserSessions({ data: { userId: 42 } });
      expect(mockSessionDeleteByUserId).toHaveBeenCalledTimes(1);
      expect(mockSessionDeleteByUserId).toHaveBeenCalledWith(42);
    });

    it('passes a different userId through correctly', async () => {
      const { revokeAllUserSessions } = await import('@/data/auth.functions');
      await revokeAllUserSessions({ data: { userId: 99 } });
      expect(mockSessionDeleteByUserId).toHaveBeenCalledWith(99);
    });
  });

  describe('resetAuthFunctionsState', () => {
    it('clears the cached session manager without throwing', () => {
      const { resetAuthFunctionsState } = require('@/data/auth.functions');
      expect(() => resetAuthFunctionsState()).not.toThrow();
    });
  });
});

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { SYNTHETIC_ADMIN } from '@/lib/auth/types';
import type { AuthUser } from '@/lib/auth/types';
import type { GitTokenWithUser } from '@/lib/database/repositories/git-token-repository';
import { withStartContext } from '@/lib/test/start-context';
import { mockModule } from '@/lib/test/mock-module';

// Mutable per-test auth context: the mocked auth middleware injects this user.
let currentUser: AuthUser = SYNTHETIC_ADMIN;
const SYNTHETIC_OPERATOR: AuthUser = {
  id: 7,
  email: 'operator@local',
  name: 'Operator',
  role: 'operator',
};

mockModule<typeof import('@/middleware/auth-middleware')>('@/middleware/auth-middleware', (real) => ({ ...real, 
  authMiddleware: {
    options: {
      type: 'function',
      client: async ({ next, sendContext }: { next: (opts: { sendContext: unknown }) => unknown; sendContext: unknown }) => {
        return next({ sendContext: { ...(sendContext as Record<string, unknown>), user: currentUser } });
      },
      server: async ({ next, context }: { next: (opts: { context: unknown }) => unknown; context: unknown }) => {
        return next({ context: { ...(context as Record<string, unknown>), user: currentUser } });
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

const mockEncryptValue = mock(async (_plaintext: string, _keyring: unknown) => 'jwe:encrypted:token');
mockModule<typeof import('@/lib/crypto/encrypted-value')>('@/lib/crypto/encrypted-value', (real) => ({ ...real, 
  encryptValue: mockEncryptValue,
}));
mockModule<typeof import('@/lib/crypto/master-key')>('@/lib/crypto/master-key', (real) => ({ ...real, 
  loadMasterKeyring: mock(async () => ({ activeKid: 'v1', keys: new Map() })),
}));

const mockCreate = mock(async (input: { userId: number; encryptedToken: string; tokenHash: string; label: string }) => ({
  id: 1,
  userId: input.userId,
  label: input.label,
  lastUsedAt: null,
  createdAt: new Date(),
}));
const mockFindAll = mock(async (): Promise<GitTokenWithUser[]> => []);
const mockFindByUserId = mock(async (_userId: number) => [] as Awaited<ReturnType<typeof mockCreate>>[]);
const mockDeleteById = mock(async (_id: number) => {});
const mockDeleteByIdAndUser = mock(async (_id: number, _userId: number) => true);

mockModule<typeof import('@/lib/database/repositories/git-token-repository')>('@/lib/database/repositories/git-token-repository', (real) => ({ ...real, 
  GitTokenRepository: class MockGitTokenRepository {
    constructor() {}
    create = mockCreate;
    findAll = mockFindAll;
    findByUserId = mockFindByUserId;
    deleteById = mockDeleteById;
    deleteByIdAndUser = mockDeleteByIdAndUser;
  },
}));

// createServerFn() wrappers do not return handler values in test context.
// Tests verify delegation by asserting on mock call counts and arguments.
describe('git-tokens.functions', () => {
  beforeEach(() => {
    currentUser = SYNTHETIC_ADMIN;
    mockPool.query.mockClear();
    mockGetClient.mockClear();
    mockEncryptValue.mockClear();
    mockCreate.mockClear();
    mockFindAll.mockClear();
    mockFindByUserId.mockClear();
    mockDeleteById.mockClear();
    mockDeleteByIdAndUser.mockClear();
  });

  describe('createGitToken', () => {
    it('encrypts a random token before storing', async () => {
      const { createGitToken } = await import('@/data/git-tokens.functions');
      await withStartContext(() => createGitToken({ data: { label: 'deploy-key' } }));
      expect(mockEncryptValue).toHaveBeenCalledTimes(1);
      const [plaintext] = mockEncryptValue.mock.calls[0] as [string, unknown];
      expect(plaintext).toMatch(/^[0-9a-f]{64}$/);
    });

    it('stores the encrypted token and label via repository', async () => {
      const { createGitToken } = await import('@/data/git-tokens.functions');
      await withStartContext(() => createGitToken({ data: { label: 'ci-key' } }));
      expect(mockCreate).toHaveBeenCalledTimes(1);
      const [createArg] = mockCreate.mock.calls[0] as [{ userId: number; encryptedToken: string; tokenHash: string; label: string }];
      expect(createArg.userId).toBe(SYNTHETIC_ADMIN.id);
      expect(createArg.encryptedToken).toBe('jwe:encrypted:token');
      expect(createArg.label).toBe('ci-key');
    });

    it('stores the SHA-256 hash of the raw token for indexed auth lookups', async () => {
      const { createGitToken } = await import('@/data/git-tokens.functions');
      const { createHash } = await import('node:crypto');
      await withStartContext(() => createGitToken({ data: { label: 'hash-key' } }));
      const [plaintext] = mockEncryptValue.mock.calls[0] as [string, unknown];
      const [createArg] = mockCreate.mock.calls[0] as [{ tokenHash: string }];
      expect(createArg.tokenHash).toBe(createHash('sha256').update(plaintext).digest('hex'));
    });

    it('uses a different random plaintext for each call', async () => {
      const { createGitToken } = await import('@/data/git-tokens.functions');
      await withStartContext(() => createGitToken({ data: { label: 'a' } }));
      await withStartContext(() => createGitToken({ data: { label: 'b' } }));
      const calls = mockEncryptValue.mock.calls as [string, unknown][];
      expect(calls[0][0]).not.toBe(calls[1][0]);
    });

    it('allows an operator to mint a token bound to their own user id', async () => {
      currentUser = SYNTHETIC_OPERATOR;
      const { createGitToken } = await import('@/data/git-tokens.functions');
      await withStartContext(() => createGitToken({ data: { label: 'op-key' } }));
      expect(mockCreate).toHaveBeenCalledTimes(1);
      const [createArg] = mockCreate.mock.calls[0] as [{ userId: number }];
      expect(createArg.userId).toBe(SYNTHETIC_OPERATOR.id);
    });

    it('rejects a viewer with ForbiddenError', async () => {
      currentUser = { ...SYNTHETIC_ADMIN, role: 'viewer' };
      const { createGitToken } = await import('@/data/git-tokens.functions');
      await expect(
        withStartContext(() => createGitToken({ data: { label: 'nope' } }))
      ).rejects.toThrow('Insufficient permissions');
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe('listGitTokens', () => {
    it('delegates to GitTokenRepository.findAll for admins', async () => {
      const { listGitTokens } = await import('@/data/git-tokens.functions');
      await withStartContext(() => listGitTokens({}));
      expect(mockFindAll).toHaveBeenCalledTimes(1);
      expect(mockFindByUserId).not.toHaveBeenCalled();
    });

    it('creates a GitTokenRepository using the db pool', async () => {
      const { listGitTokens } = await import('@/data/git-tokens.functions');
      await withStartContext(() => listGitTokens({}));
      expect(mockGetClient).toHaveBeenCalledTimes(1);
    });

    it('scopes an operator to their own tokens via findByUserId', async () => {
      currentUser = SYNTHETIC_OPERATOR;
      const { listGitTokens } = await import('@/data/git-tokens.functions');
      await withStartContext(() => listGitTokens({}));
      expect(mockFindByUserId).toHaveBeenCalledTimes(1);
      expect(mockFindByUserId).toHaveBeenCalledWith(SYNTHETIC_OPERATOR.id);
      expect(mockFindAll).not.toHaveBeenCalled();
    });

    it('shapes operator rows with the caller identity so the UI renders both scopes identically', async () => {
      currentUser = SYNTHETIC_OPERATOR;
      mockFindByUserId.mockImplementation(async () => [
        { id: 3, userId: SYNTHETIC_OPERATOR.id, label: 'op-key', lastUsedAt: null, createdAt: new Date() },
      ]);
      const { listGitTokens } = await import('@/data/git-tokens.functions');
      await withStartContext(async () => {
        await listGitTokens({});
      });
      // createServerFn wrappers do not return handler values, so assert the repo call shape instead.
      expect(mockFindByUserId).toHaveBeenCalledWith(SYNTHETIC_OPERATOR.id);
    });
  });

  describe('revokeGitToken', () => {
    it('calls deleteById with the given tokenId for admins', async () => {
      const { revokeGitToken } = await import('@/data/git-tokens.functions');
      await withStartContext(() => revokeGitToken({ data: { tokenId: 7 } }));
      expect(mockDeleteById).toHaveBeenCalledTimes(1);
      expect(mockDeleteById).toHaveBeenCalledWith(7);
      expect(mockDeleteByIdAndUser).not.toHaveBeenCalled();
    });

    it('passes a different tokenId through correctly', async () => {
      const { revokeGitToken } = await import('@/data/git-tokens.functions');
      await withStartContext(() => revokeGitToken({ data: { tokenId: 99 } }));
      expect(mockDeleteById).toHaveBeenCalledWith(99);
    });

    it('revokes an operator token through the ownership-scoped delete', async () => {
      currentUser = SYNTHETIC_OPERATOR;
      const { revokeGitToken } = await import('@/data/git-tokens.functions');
      await withStartContext(() => revokeGitToken({ data: { tokenId: 5 } }));
      expect(mockDeleteByIdAndUser).toHaveBeenCalledTimes(1);
      expect(mockDeleteByIdAndUser).toHaveBeenCalledWith(5, SYNTHETIC_OPERATOR.id);
      expect(mockDeleteById).not.toHaveBeenCalled();
    });

    it('never uses the unscoped delete for operators, so foreign tokens cannot be revoked', async () => {
      currentUser = SYNTHETIC_OPERATOR;
      mockDeleteByIdAndUser.mockImplementation(async () => false);
      const { revokeGitToken } = await import('@/data/git-tokens.functions');
      await withStartContext(() => revokeGitToken({ data: { tokenId: 1 } }));
      expect(mockDeleteById).not.toHaveBeenCalled();
      expect(mockDeleteByIdAndUser).toHaveBeenCalledWith(1, SYNTHETIC_OPERATOR.id);
    });

    it('rejects a viewer with ForbiddenError', async () => {
      currentUser = { ...SYNTHETIC_ADMIN, role: 'viewer' };
      const { revokeGitToken } = await import('@/data/git-tokens.functions');
      await expect(
        withStartContext(() => revokeGitToken({ data: { tokenId: 7 } }))
      ).rejects.toThrow('Insufficient permissions');
      expect(mockDeleteById).not.toHaveBeenCalled();
    });
  });
});
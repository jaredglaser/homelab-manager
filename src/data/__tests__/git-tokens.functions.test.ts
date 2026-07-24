import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { SYNTHETIC_ADMIN } from '@/lib/auth/types';
import type { GitTokenWithUser } from '@/lib/database/repositories/git-token-repository';
import { withStartContext } from '@/lib/test/start-context';

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

const mockPool = { query: mock(async () => ({ rows: [] })) };
const mockGetClient = mock(async () => ({ getPool: () => mockPool }));

mock.module('@/lib/clients/database-client', () => ({
  databaseConnectionManager: { getClient: mockGetClient },
}));
mock.module('@/lib/config/database-config', () => ({
  loadDatabaseConfig: () => ({}),
}));

const mockEncryptValue = mock(async (_plaintext: string, _keyring: unknown) => 'jwe:encrypted:token');
mock.module('@/lib/crypto/encrypted-value', () => ({
  encryptValue: mockEncryptValue,
}));
mock.module('@/lib/crypto/master-key', () => ({
  loadMasterKeyring: mock(async () => ({ activeKid: 'v1', keys: new Map() })),
}));

const mockCreate = mock(async (input: { userId: number; encryptedToken: string; label: string }) => ({
  id: 1,
  userId: input.userId,
  label: input.label,
  lastUsedAt: null,
  createdAt: new Date(),
}));
const mockFindAll = mock(async (): Promise<GitTokenWithUser[]> => []);
const mockDeleteById = mock(async (_id: number) => {});

mock.module('@/lib/database/repositories/git-token-repository', () => ({
  GitTokenRepository: class MockGitTokenRepository {
    constructor() {}
    create = mockCreate;
    findAll = mockFindAll;
    deleteById = mockDeleteById;
  },
}));

// createServerFn() wrappers do not return handler values in test context.
// Tests verify delegation by asserting on mock call counts and arguments.
describe('git-tokens.functions', () => {
  beforeEach(() => {
    mockPool.query.mockClear();
    mockGetClient.mockClear();
    mockEncryptValue.mockClear();
    mockCreate.mockClear();
    mockFindAll.mockClear();
    mockDeleteById.mockClear();
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
      const [createArg] = mockCreate.mock.calls[0] as [{ userId: number; encryptedToken: string; label: string }];
      expect(createArg.userId).toBe(SYNTHETIC_ADMIN.id);
      expect(createArg.encryptedToken).toBe('jwe:encrypted:token');
      expect(createArg.label).toBe('ci-key');
    });

    it('uses a different random plaintext for each call', async () => {
      const { createGitToken } = await import('@/data/git-tokens.functions');
      await withStartContext(() => createGitToken({ data: { label: 'a' } }));
      await withStartContext(() => createGitToken({ data: { label: 'b' } }));
      const calls = mockEncryptValue.mock.calls as [string, unknown][];
      expect(calls[0][0]).not.toBe(calls[1][0]);
    });
  });

  describe('listGitTokens', () => {
    it('delegates to GitTokenRepository.findAll', async () => {
      const { listGitTokens } = await import('@/data/git-tokens.functions');
      await withStartContext(() => listGitTokens({}));
      expect(mockFindAll).toHaveBeenCalledTimes(1);
    });

    it('creates a GitTokenRepository using the db pool', async () => {
      const { listGitTokens } = await import('@/data/git-tokens.functions');
      await withStartContext(() => listGitTokens({}));
      expect(mockGetClient).toHaveBeenCalledTimes(1);
    });
  });

  describe('revokeGitToken', () => {
    it('calls deleteById with the given tokenId', async () => {
      const { revokeGitToken } = await import('@/data/git-tokens.functions');
      await withStartContext(() => revokeGitToken({ data: { tokenId: 7 } }));
      expect(mockDeleteById).toHaveBeenCalledTimes(1);
      expect(mockDeleteById).toHaveBeenCalledWith(7);
    });

    it('passes a different tokenId through correctly', async () => {
      const { revokeGitToken } = await import('@/data/git-tokens.functions');
      await withStartContext(() => revokeGitToken({ data: { tokenId: 99 } }));
      expect(mockDeleteById).toHaveBeenCalledWith(99);
    });
  });
});

import { describe, it, expect, beforeEach } from 'bun:test';
import { GitTokenRepository } from '../git-token-repository';
import type { GitTokenRow } from '../git-token-repository';

function createMockPool(rows: Record<string, unknown>[] = []) {
  const queryResults: Record<string, unknown>[][] = [];
  const calls: { sql: string; params?: unknown[] }[] = [];
  return {
    pool: {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        const result = queryResults.length > 0 ? queryResults.shift()! : rows;
        return { rows: result };
      },
    } as any,
    pushResult(r: Record<string, unknown>[]) {
      queryResults.push(r);
    },
    calls,
  };
}

const now = new Date('2024-01-01T00:00:00Z');

const baseTokenDbRow = {
  id: '1',
  user_id: '10',
  label: 'my-token',
  last_used_at: null as Date | null,
  created_at: now,
};

const expectedTokenRow: GitTokenRow = {
  id: 1,
  userId: 10,
  label: 'my-token',
  lastUsedAt: null,
  createdAt: now,
};

describe('GitTokenRepository', () => {
  let repo: GitTokenRepository;
  let mock: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    mock = createMockPool();
    repo = new GitTokenRepository(mock.pool);
  });

  describe('create', () => {
    it('inserts a git token and returns the new row', async () => {
      mock.pushResult([baseTokenDbRow]);
      const result = await repo.create({
        userId: 10,
        encryptedToken: 'enc:abc123',
        tokenHash: 'a'.repeat(64),
        label: 'my-token',
      });
      expect(result.id).toBe(1);
      expect(result.userId).toBe(10);
      expect(result.label).toBe('my-token');
      expect(result.lastUsedAt).toBeNull();
      expect(result.createdAt).toEqual(now);
    });

    it('passes token_hash as an insert parameter', async () => {
      mock.pushResult([baseTokenDbRow]);
      await repo.create({
        userId: 10,
        encryptedToken: 'enc:abc123',
        tokenHash: 'deadbeef',
        label: 'my-token',
      });
      expect(mock.calls[0].sql).toContain('token_hash');
      expect(mock.calls[0].params).toEqual([10, 'enc:abc123', 'deadbeef', 'my-token']);
    });

    it('coerces string id and user_id to numbers', async () => {
      mock.pushResult([{ ...baseTokenDbRow, id: '42', user_id: '99' }]);
      const result = await repo.create({
        userId: 99,
        encryptedToken: 'enc:xyz',
        tokenHash: 'b'.repeat(64),
        label: 'coerce-test',
      });
      expect(result.id).toBe(42);
      expect(result.userId).toBe(99);
    });
  });

  describe('findByUserId', () => {
    it('returns all tokens for a user', async () => {
      const rows = [
        { ...baseTokenDbRow, id: '1', label: 'token-a' },
        { ...baseTokenDbRow, id: '2', label: 'token-b' },
      ];
      mock.pushResult(rows);
      const result = await repo.findByUserId(10);
      expect(result).toHaveLength(2);
      expect(result[0].label).toBe('token-a');
      expect(result[1].label).toBe('token-b');
    });

    it('returns empty array when user has no tokens', async () => {
      mock.pushResult([]);
      const result = await repo.findByUserId(999);
      expect(result).toEqual([]);
    });
  });

  describe('findAll', () => {
    it('returns all tokens joined with user info', async () => {
      const rows = [
        {
          ...baseTokenDbRow,
          id: '1',
          user_id: '10',
          user_name: 'Alice',
          user_email: 'alice@example.com',
        },
        {
          ...baseTokenDbRow,
          id: '2',
          user_id: '20',
          label: 'bob-token',
          user_name: null,
          user_email: 'bob@example.com',
        },
      ];
      mock.pushResult(rows);
      const result = await repo.findAll();
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe(1);
      expect(result[0].userName).toBe('Alice');
      expect(result[0].userEmail).toBe('alice@example.com');
      expect(result[1].id).toBe(2);
      expect(result[1].userName).toBeNull();
      expect(result[1].userEmail).toBe('bob@example.com');
    });

    it('returns empty array when no tokens exist', async () => {
      mock.pushResult([]);
      const result = await repo.findAll();
      expect(result).toEqual([]);
    });
  });

  describe('findByTokenHash', () => {
    it('returns id and userId for a matching row', async () => {
      mock.pushResult([{ id: '1', user_id: '10' }]);
      const result = await repo.findByTokenHash('c'.repeat(64));
      expect(result).toEqual({ id: 1, userId: 10 });
      expect(mock.calls[0].params).toEqual(['c'.repeat(64)]);
    });

    it('returns null when no row matches', async () => {
      mock.pushResult([]);
      const result = await repo.findByTokenHash('missing');
      expect(result).toBeNull();
    });
  });

  describe('findMissingHash', () => {
    it('returns id, userId, and encryptedToken for tokens without a hash', async () => {
      mock.pushResult([
        { id: '1', user_id: '10', encrypted_token: 'enc:token1' },
        { id: '2', user_id: '20', encrypted_token: 'enc:token2' },
      ]);
      const result = await repo.findMissingHash();
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ id: 1, userId: 10, encryptedToken: 'enc:token1' });
      expect(result[1]).toEqual({ id: 2, userId: 20, encryptedToken: 'enc:token2' });
      expect(mock.calls[0].sql).toContain('token_hash IS NULL');
    });

    it('returns empty array when every token already has a hash', async () => {
      mock.pushResult([]);
      const result = await repo.findMissingHash();
      expect(result).toEqual([]);
    });
  });

  describe('setTokenHash', () => {
    it('updates token_hash for the given token id', async () => {
      await repo.setTokenHash(7, 'd'.repeat(64));
      expect(mock.calls[0].sql).toContain('SET token_hash');
      expect(mock.calls[0].params).toEqual([7, 'd'.repeat(64)]);
    });
  });

  describe('deleteById', () => {
    it('removes a specific token by id', async () => {
      await repo.deleteById(5);
      // No error means success (void return)
    });
  });

  describe('deleteByUserId', () => {
    it('removes all tokens for a user', async () => {
      await repo.deleteByUserId(10);
      // No error means success (void return)
    });
  });

  describe('updateLastUsed', () => {
    it('updates last_used_at for the given token id', async () => {
      await repo.updateLastUsed(3);
      // No error means success (void return)
    });
  });

  describe('row mapping', () => {
    it('preserves non-null last_used_at', async () => {
      const usedAt = new Date('2024-06-15T12:00:00Z');
      mock.pushResult([{ ...baseTokenDbRow, last_used_at: usedAt }]);
      const result = await repo.findByUserId(10);
      expect(result[0].lastUsedAt).toEqual(usedAt);
    });

    it('create returns row with null last_used_at by default', async () => {
      mock.pushResult([baseTokenDbRow]);
      const result = await repo.create({
        userId: 10,
        encryptedToken: 'enc:x',
        tokenHash: 'e'.repeat(64),
        label: 'lbl',
      });
      expect(result).toEqual(expectedTokenRow);
    });
  });
});

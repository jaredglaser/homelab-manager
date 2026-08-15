import { describe, it, expect, beforeEach } from 'bun:test';
import { ApiTokenRepository } from '../api-token-repository';
import type { ApiTokenRow } from '../api-token-repository';

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
  label: 'mcp-token',
  scopes: ['stacks:read', 'stacks:deploy'],
  last_used_at: null as Date | null,
  created_at: now,
};

const expectedTokenRow: ApiTokenRow = {
  id: 1,
  label: 'mcp-token',
  scopes: ['stacks:read', 'stacks:deploy'],
  lastUsedAt: null,
  createdAt: now,
};

describe('ApiTokenRepository', () => {
  let repo: ApiTokenRepository;
  let mock: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    mock = createMockPool();
    repo = new ApiTokenRepository(mock.pool);
  });

  describe('create', () => {
    it('inserts an api token and returns the new row', async () => {
      mock.pushResult([baseTokenDbRow]);
      const result = await repo.create({
        encryptedToken: 'enc:abc123',
        tokenHash: 'a'.repeat(64),
        label: 'mcp-token',
        scopes: ['stacks:read', 'stacks:deploy'],
      });
      expect(result).toEqual(expectedTokenRow);
    });

    it('passes scopes as an insert parameter', async () => {
      mock.pushResult([baseTokenDbRow]);
      await repo.create({
        encryptedToken: 'enc:abc123',
        tokenHash: 'deadbeef',
        label: 'mcp-token',
        scopes: ['stacks:read'],
      });
      expect(mock.calls[0].sql).toContain('scopes');
      expect(mock.calls[0].params).toEqual(['enc:abc123', 'deadbeef', 'mcp-token', ['stacks:read']]);
    });

    it('coerces string id to a number', async () => {
      mock.pushResult([{ ...baseTokenDbRow, id: '42' }]);
      const result = await repo.create({
        encryptedToken: 'enc:xyz',
        tokenHash: 'b'.repeat(64),
        label: 'coerce-test',
        scopes: [],
      });
      expect(result.id).toBe(42);
    });

    it('handles an empty scopes array', async () => {
      mock.pushResult([{ ...baseTokenDbRow, scopes: [] }]);
      const result = await repo.create({
        encryptedToken: 'enc:none',
        tokenHash: 'c'.repeat(64),
        label: 'no-scopes',
        scopes: [],
      });
      expect(result.scopes).toEqual([]);
    });
  });

  describe('findAll', () => {
    it('returns all tokens ordered by creation', async () => {
      const rows = [
        { ...baseTokenDbRow, id: '1', label: 'token-a' },
        { ...baseTokenDbRow, id: '2', label: 'token-b' },
      ];
      mock.pushResult(rows);
      const result = await repo.findAll();
      expect(result).toHaveLength(2);
      expect(result[0].label).toBe('token-a');
      expect(result[1].label).toBe('token-b');
      expect(mock.calls[0].sql).toContain('ORDER BY created_at DESC');
    });

    it('returns empty array when no tokens exist', async () => {
      mock.pushResult([]);
      const result = await repo.findAll();
      expect(result).toEqual([]);
    });
  });

  describe('findByTokenHash', () => {
    it('returns id and scopes for a matching row', async () => {
      mock.pushResult([{ id: '1', scopes: ['stacks:read'] }]);
      const result = await repo.findByTokenHash('d'.repeat(64));
      expect(result).toEqual({ id: 1, scopes: ['stacks:read'] });
      expect(mock.calls[0].params).toEqual(['d'.repeat(64)]);
    });

    it('returns null when no row matches', async () => {
      mock.pushResult([]);
      const result = await repo.findByTokenHash('missing');
      expect(result).toBeNull();
    });
  });

  describe('deleteById', () => {
    it('removes a specific token by id', async () => {
      await repo.deleteById(5);
      expect(mock.calls[0].sql).toContain('DELETE FROM api_tokens');
      expect(mock.calls[0].params).toEqual([5]);
    });
  });

  describe('updateLastUsed', () => {
    it('updates last_used_at for the given token id', async () => {
      await repo.updateLastUsed(3);
      expect(mock.calls[0].sql).toContain('SET last_used_at');
      expect(mock.calls[0].params).toEqual([3]);
    });
  });

  describe('row mapping', () => {
    it('preserves non-null last_used_at', async () => {
      const usedAt = new Date('2024-06-15T12:00:00Z');
      mock.pushResult([{ ...baseTokenDbRow, last_used_at: usedAt }]);
      const result = await repo.findAll();
      expect(result[0].lastUsedAt).toEqual(usedAt);
    });
  });
});

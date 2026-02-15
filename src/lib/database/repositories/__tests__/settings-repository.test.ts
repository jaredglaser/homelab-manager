import { describe, it, expect, beforeEach } from 'bun:test';
import { SettingsRepository } from '../settings-repository';

function createMockPool(rows: Record<string, unknown>[] = []) {
  const queryResults: Record<string, unknown>[][] = [];
  return {
    pool: {
      query: async (_sql: string, _params?: unknown[]) => {
        const result = queryResults.length > 0 ? queryResults.shift()! : rows;
        return { rows: result };
      },
    } as any,
    /** Push a result set that will be returned by the next query call */
    pushResult(r: Record<string, unknown>[]) {
      queryResults.push(r);
    },
  };
}

describe('SettingsRepository', () => {
  let repo: SettingsRepository;
  let mock: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    mock = createMockPool();
    repo = new SettingsRepository(mock.pool);
  });

  describe('get', () => {
    it('returns null when key does not exist', async () => {
      mock.pushResult([]);
      const result = await repo.get('nonexistent');
      expect(result).toBeNull();
    });

    it('returns value when key exists', async () => {
      mock.pushResult([{ value: 'bytes' }]);
      const result = await repo.get('docker/memoryDisplayMode');
      expect(result).toBe('bytes');
    });
  });

  describe('getAll', () => {
    it('returns empty map when no settings exist', async () => {
      mock.pushResult([]);
      const result = await repo.getAll();
      expect(result.size).toBe(0);
    });

    it('returns all settings as a map', async () => {
      mock.pushResult([
        { key: 'docker/memoryDisplayMode', value: 'bytes' },
        { key: 'zfs/someSetting', value: 'enabled' },
      ]);
      const result = await repo.getAll();
      expect(result.size).toBe(2);
      expect(result.get('docker/memoryDisplayMode')).toBe('bytes');
      expect(result.get('zfs/someSetting')).toBe('enabled');
    });
  });

  describe('set', () => {
    it('calls query with upsert SQL', async () => {
      const queries: { sql: string; params: unknown[] }[] = [];
      const pool = {
        query: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params: params ?? [] });
          return { rows: [] };
        },
      } as any;

      const r = new SettingsRepository(pool);
      await r.set('docker/memoryDisplayMode', 'bytes');

      expect(queries).toHaveLength(2);
      expect(queries[0].sql).toContain('INSERT INTO settings');
      expect(queries[0].sql).toContain('ON CONFLICT');
      expect(queries[0].params).toEqual(['docker/memoryDisplayMode', 'bytes']);
      expect(queries[1].sql).toContain('pg_notify');
      expect(queries[1].params).toEqual(['docker/memoryDisplayMode']);
    });
  });
});

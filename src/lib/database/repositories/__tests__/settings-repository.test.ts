import { describe, it, expect, beforeEach } from 'bun:test';
import { SettingsRepository } from '../settings-repository';
import { SETTINGS_KEYS, VIEW_STATE_KEYS } from '@/lib/constants/settings-keys';

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

    it('skips the notify for a view-state key', async () => {
      const queries: { sql: string; params: unknown[] }[] = [];
      const pool = {
        query: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params: params ?? [] });
          return { rows: [] };
        },
      } as any;

      const r = new SettingsRepository(pool);
      await r.set(SETTINGS_KEYS.docker.expandedHosts, '["server1"]');

      expect(queries).toHaveLength(1);
      expect(queries[0].sql).toContain('INSERT INTO settings');
    });
  });

  describe('getMany', () => {
    it('returns an empty map without querying for an empty key list', async () => {
      let called = false;
      const pool = {
        query: async () => { called = true; return { rows: [] }; },
      } as any;

      const result = await new SettingsRepository(pool).getMany([]);

      expect(result.size).toBe(0);
      expect(called).toBe(false);
    });

    it('returns only the requested keys', async () => {
      mock.pushResult([
        { key: SETTINGS_KEYS.docker.expandedHosts, value: '["server1"]' },
      ]);
      const result = await repo.getMany(VIEW_STATE_KEYS);
      expect(result.size).toBe(1);
      expect(result.get(SETTINGS_KEYS.docker.expandedHosts)).toBe('["server1"]');
    });
  });
});

import { describe, it, expect, beforeEach } from 'bun:test';
import { SettingsRepository, USER_SETTINGS_CHANNEL, UserSettingsRepository, parseUserSettingsNotifyPayload } from '../settings-repository';

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

describe('UserSettingsRepository', () => {
  function recordingPool(rows: Record<string, unknown>[] = []) {
    const calls: { sql: string; params: unknown[] }[] = [];
    return {
      calls,
      pool: {
        query: (sql: string, params: unknown[] = []) => {
          calls.push({ sql, params });
          return Promise.resolve({ rows });
        },
      } as never,
    };
  }

  it('reads only the given user\'s rows', async () => {
    const { calls, pool } = recordingPool([{ key: 'general/use12HourTime', value: 'false' }]);
    const all = await new UserSettingsRepository(pool).getAll(7);
    expect(Object.fromEntries(all)).toEqual({ 'general/use12HourTime': 'false' });
    expect(calls[0].sql).toContain('WHERE user_id = $1');
    expect(calls[0].params).toEqual([7]);
  });

  it('upserts one user\'s value and notifies with that user and key', async () => {
    const { calls, pool } = recordingPool();
    await new UserSettingsRepository(pool).set(0, 'docker/decimals/cpu', 'true');
    expect(calls[0].sql).toContain('ON CONFLICT (user_id, key)');
    expect(calls[0].params).toEqual([0, 'docker/decimals/cpu', 'true']);
    expect(calls[1].params).toEqual([USER_SETTINGS_CHANNEL, '0:docker/decimals/cpu']);
  });

  it.each([
    ['12:general/lightPalette', { scope: 12, key: 'general/lightPalette' }],
    ['0:zfs/decimals/diskSpeed', { scope: 0, key: 'zfs/decimals/diskSpeed' }],
    ['general/lightPalette', null],
    [':general/lightPalette', null],
    ['12:', null],
    ['x:general/lightPalette', null],
  ])('parses the notify payload %s', (payload, expected) => {
    expect(parseUserSettingsNotifyPayload(payload)).toEqual(expected);
  });
});

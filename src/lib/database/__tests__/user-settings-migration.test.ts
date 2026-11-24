import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { USER_SETTINGS_KEYS } from '@/lib/constants/settings-keys';

const FILE = join(import.meta.dir, '..', '..', '..', '..', 'migrations', '049_user_settings.sql');

describe('049_user_settings.sql', () => {
  test('deletes the global row of every per-user display key and nothing else', async () => {
    const sql = await Bun.file(FILE).text();
    const list = /DELETE FROM settings WHERE key IN \(([^)]*)\)/.exec(sql)?.[1] ?? '';
    const deleted = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(deleted).toEqual([...USER_SETTINGS_KEYS].sort());
  });

  test('keys each value by user and setting', async () => {
    const sql = await Bun.file(FILE).text();
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS user_settings');
    expect(sql).toContain('PRIMARY KEY (user_id, key)');
  });
});

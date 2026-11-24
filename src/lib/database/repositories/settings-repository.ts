import type { Pool } from 'pg';

interface SettingValueRow {
  value: string;
}

interface SettingKeyValueRow {
  key: string;
  value: string;
}

export class SettingsRepository {
  constructor(private pool: Pool) {}

  async get(key: string): Promise<string | null> {
    const result = await this.pool.query<SettingValueRow>(
      'SELECT value FROM settings WHERE key = $1',
      [key]
    );
    return result.rows.length > 0 ? result.rows[0].value : null;
  }

  async getAll(): Promise<Map<string, string>> {
    const result = await this.pool.query<SettingKeyValueRow>('SELECT key, value FROM settings');
    const map = new Map<string, string>();
    for (const row of result.rows) {
      map.set(row.key, row.value);
    }
    return map;
  }

  async set(key: string, value: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value]
    );
    await this.pool.query(`SELECT pg_notify('settings_change', $1)`, [key]);
  }
}

export const USER_SETTINGS_CHANNEL = 'user_settings_change';

export function userSettingsNotifyPayload(userId: number, key: string): string {
  return `${userId}:${key}`;
}

export function parseUserSettingsNotifyPayload(payload: string): { scope: number; key: string } | null {
  const sep = payload.indexOf(':');
  if (sep <= 0 || sep === payload.length - 1) return null;
  const userId = Number(payload.slice(0, sep));
  if (!Number.isSafeInteger(userId)) return null;
  return { scope: userId, key: payload.slice(sep + 1) };
}

export class UserSettingsRepository {
  constructor(private pool: Pool) {}

  async get(userId: number, key: string): Promise<string | null> {
    const result = await this.pool.query<SettingValueRow>(
      'SELECT value FROM user_settings WHERE user_id = $1 AND key = $2',
      [userId, key]
    );
    return result.rows.length > 0 ? result.rows[0].value : null;
  }

  async getAll(userId: number): Promise<Map<string, string>> {
    const result = await this.pool.query<SettingKeyValueRow>(
      'SELECT key, value FROM user_settings WHERE user_id = $1',
      [userId]
    );
    return new Map(result.rows.map((row) => [row.key, row.value]));
  }

  async set(userId: number, key: string, value: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO user_settings (user_id, key, value, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [userId, key, value]
    );
    await this.pool.query(`SELECT pg_notify($1, $2)`, [USER_SETTINGS_CHANNEL, userSettingsNotifyPayload(userId, key)]);
  }
}

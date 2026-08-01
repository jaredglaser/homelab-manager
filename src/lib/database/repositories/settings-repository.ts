import type { Pool } from 'pg';
import { isViewStateKey } from '@/lib/constants/settings-keys';

export interface SettingRow {
  key: string;
  value: string;
  updated_at: Date;
}

export class SettingsRepository {
  constructor(private pool: Pool) {}

  async get(key: string): Promise<string | null> {
    const result = await this.pool.query(
      'SELECT value FROM settings WHERE key = $1',
      [key]
    );
    return result.rows.length > 0 ? result.rows[0].value : null;
  }

  async getAll(): Promise<Map<string, string>> {
    const result = await this.pool.query('SELECT key, value FROM settings');
    const map = new Map<string, string>();
    for (const row of result.rows as SettingRow[]) {
      map.set(row.key, row.value);
    }
    return map;
  }

  async getMany(keys: readonly string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (keys.length === 0) return map;
    const result = await this.pool.query(
      'SELECT key, value FROM settings WHERE key = ANY($1)',
      [keys]
    );
    for (const row of result.rows as SettingRow[]) {
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
    // View state is never broadcast, and a row expand writes on every click.
    if (isViewStateKey(key)) return;
    await this.pool.query(`SELECT pg_notify('settings_change', $1)`, [key]);
  }
}

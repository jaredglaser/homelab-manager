import type { Pool } from 'pg';

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

  async set(key: string, value: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value]
    );
  }
}

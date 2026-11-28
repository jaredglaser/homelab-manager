import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { laneDatabaseConfig } from './lane-config';

export interface SessionRow {
  expires: number;
  role: string;
  email: string;
}

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

async function withPool<T>(run: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool(laneDatabaseConfig());
  try {
    return await run(pool);
  } finally {
    await pool.end();
  }
}

export async function sessionRow(rawToken: string): Promise<SessionRow | null> {
  return await withPool(async (pool) => {
    const result = await pool.query<SessionRow>(
      `SELECT extract(epoch FROM s.expires_at)::float8 AS expires, u.role, u.email
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1`,
      [hashToken(rawToken)],
    );
    return result.rows[0] ?? null;
  });
}

export async function expireSessionRow(rawToken: string): Promise<void> {
  await withPool((pool) =>
    pool.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      hashToken(rawToken),
    ]),
  );
}

export async function sessionCountForEmail(email: string): Promise<number> {
  return await withPool(async (pool) => {
    const result = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = $1',
      [email],
    );
    return result.rows[0]?.n ?? 0;
  });
}

export async function clearUserSettings(email: string): Promise<void> {
  await withPool((pool) =>
    pool.query('DELETE FROM user_settings WHERE user_id = (SELECT id FROM users WHERE email = $1)', [email]),
  );
}

export async function userSettingValue(email: string, key: string): Promise<string | null> {
  return await withPool(async (pool) => {
    const result = await pool.query<{ value: string }>(
      `SELECT s.value FROM user_settings s JOIN users u ON u.id = s.user_id WHERE u.email = $1 AND s.key = $2`,
      [email, key],
    );
    return result.rows[0]?.value ?? null;
  });
}

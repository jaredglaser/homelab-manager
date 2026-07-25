import { Pool } from 'pg';
import type { PoolConfig } from 'pg';

const MAINTENANCE_DATABASE = 'postgres';

function baseConfig(): PoolConfig {
  return {
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_USER ?? 'postgres',
    password: process.env.POSTGRES_PASSWORD ?? 'postgres',
    max: 4,
    connectionTimeoutMillis: 10_000,
  };
}

export function createPool(database: string): Pool {
  return new Pool({ ...baseConfig(), database });
}

export async function recreateDatabase(name: string): Promise<void> {
  const pool = createPool(MAINTENANCE_DATABASE);
  try {
    await pool.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
    await pool.query(`CREATE DATABASE ${quoteIdent(name)}`);
  } finally {
    await pool.end();
  }
}

export async function waitForDatabase(attempts = 30, delayMs = 2000): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const pool = createPool(MAINTENANCE_DATABASE);
    try {
      await pool.query('SELECT 1');
      await pool.end();
      return;
    } catch (err) {
      lastError = err;
      await pool.end().catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`Database never became reachable: ${String(lastError)}`);
}

function quoteIdent(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
    throw new Error(`Refusing to use unsafe database identifier: ${value}`);
  }
  return `"${value}"`;
}

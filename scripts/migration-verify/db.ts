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
    // The fixtures anchor hours with date_trunc, which truncates in the session timezone, and that
    // has to agree with time_bucket's UTC-epoch alignment.
    options: '-c timezone=UTC',
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
    // A continuous-aggregate refresh logs two lines per chunk and buries the harness report; LOG
    // outranks ERROR in the log_min_messages scale, so silencing it takes 'fatal'. The cost is
    // every server ERROR and WARNING in this database, so a failed retention job is read back from
    // timescaledb_information.job_stats instead. Policy background workers log regardless of this
    // setting; the service container's own log cap is what keeps their output off the job log.
    await pool.query(`ALTER DATABASE ${quoteIdent(name)} SET log_min_messages = 'fatal'`);
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

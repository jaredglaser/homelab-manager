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
    // A continuous-aggregate refresh logs two lines per chunk, which buries the harness's own
    // report under thousands of lines when CI dumps the service container log. LOG outranks ERROR
    // in the log_min_messages scale, so silencing it takes 'fatal'.
    await pool.query(`ALTER DATABASE ${quoteIdent(name)} SET log_min_messages = 'fatal'`);
  } finally {
    await pool.end();
  }
}

/**
 * TimescaleDB fires a policy job as soon as its policy is created, so the refresh and compression
 * schedulers otherwise race the assertions for the same buckets and flood the service container log
 * that CI dumps at teardown. Every aggregate this harness reads is materialized by the backfill task
 * it calls directly. Job ids below 1000 are the built-in internal jobs.
 */
export async function disableBackgroundJobs(pool: Pool): Promise<void> {
  await pool.query(
    `SELECT alter_job(job_id, scheduled => false)
     FROM timescaledb_information.jobs WHERE job_id >= 1000`
  );
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

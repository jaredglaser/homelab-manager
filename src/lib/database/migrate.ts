import type { DatabaseClient } from '../clients/database-client';
import type { PoolClient } from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Get the root directory of the project (3 levels up from this file)
const currentDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(currentDir, '..', '..', '..');
const migrationsDir = join(projectRoot, 'migrations');

/**
 * Advisory lock key ("hlm1" in ASCII) that serializes runMigrations. Web and
 * worker boot concurrently; without it the loser hits the migrations.name
 * unique constraint and logs a spurious error.
 */
export const MIGRATIONS_ADVISORY_LOCK_KEY = 0x686c6d31;

/**
 * Opt-out marker for migrations containing statements PostgreSQL refuses to run inside a
 * transaction block (`CALL refresh_continuous_aggregate`). Must appear on its own line.
 */
export const NO_TRANSACTION_DIRECTIVE = '-- migrate:no-transaction';

const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/**
 * Split a migration file into individual statements on top-level semicolons, so a
 * no-transaction migration can send them one at a time. Multi-statement `client.query`
 * uses the simple query protocol, which wraps the batch in an implicit transaction and
 * would reject the very statements that need to run outside one.
 *
 * Comments are replaced with whitespace; string literals and dollar-quoted bodies
 * (a `DO $$ ... $$` block may contain semicolons) are copied through verbatim.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;

  while (i < sql.length) {
    if (sql.startsWith('--', i)) {
      const newline = sql.indexOf('\n', i);
      i = newline === -1 ? sql.length : newline;
      current += ' ';
      continue;
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      current += ' ';
      continue;
    }

    const char = sql[i];

    if (char === "'" || char === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === char) {
          if (sql[j + 1] === char) {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      current += sql.slice(i, j);
      i = j;
      continue;
    }

    if (char === '$') {
      const tag = DOLLAR_TAG.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? sql.length : end + tag.length;
        current += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }

    if (char === ';') {
      statements.push(current);
      current = '';
      i += 1;
      continue;
    }

    current += char;
    i += 1;
  }

  statements.push(current);
  return statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
}

function hasNoTransactionDirective(sql: string): boolean {
  return sql.split('\n').some((line) => line.trim() === NO_TRANSACTION_DIRECTIVE);
}

/**
 * Run all pending database migrations
 * Migrations are applied sequentially and tracked in the migrations table
 */
export async function runMigrations(db: DatabaseClient): Promise<void> {
  // Advisory locks are session-scoped, so lock/migrations/unlock must share one
  // connection; Pool.query() may route each statement to a different one.
  const client = await db.getPool().connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATIONS_ADVISORY_LOCK_KEY]);
    try {
      await applyPendingMigrations(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATIONS_ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

async function applyPendingMigrations(client: PoolClient): Promise<void> {
  // Create migrations table if it doesn't exist
  await client.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) UNIQUE NOT NULL,
      executed_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Get list of migration files from migrations directory
  const migrationFiles = readdirSync(migrationsDir)
    .filter(file => file.endsWith('.sql'))
    .sort(); // Ensure migrations run in order

  console.log(`[Migrations] Found ${migrationFiles.length} migration files`);

  for (const migrationFile of migrationFiles) {
    // Check if migration has already been run
    const result = await client.query(
      'SELECT 1 FROM migrations WHERE name = $1',
      [migrationFile]
    );

    if (result.rows.length > 0) {
      console.log(`[Migrations] Skipping ${migrationFile} (already applied)`);
      continue;
    }

    console.log(`[Migrations] Running ${migrationFile}...`);
    const migrationPath = join(migrationsDir, migrationFile);
    const sql = readFileSync(migrationPath, 'utf-8');

    try {
      if (hasNoTransactionDirective(sql)) {
        await applyWithoutTransaction(client, sql, migrationFile);
      } else {
        await applyInTransaction(client, sql, migrationFile);
      }
      console.log(`[Migrations] ✓ Successfully applied ${migrationFile}`);
    } catch (err) {
      console.error(`[Migrations] ✗ Failed to apply ${migrationFile}:`, err);
      throw err;
    }
  }

  console.log('[Migrations] All migrations completed successfully');
}

async function applyInTransaction(
  client: PoolClient,
  sql: string,
  migrationFile: string,
): Promise<void> {
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO migrations (name) VALUES ($1)', [migrationFile]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/**
 * Applies each statement on its own, with no surrounding transaction to roll back.
 * A failure part-way leaves the migration unrecorded and the whole file re-runs on the
 * next boot, so every statement in such a file has to be idempotent.
 */
async function applyWithoutTransaction(
  client: PoolClient,
  sql: string,
  migrationFile: string,
): Promise<void> {
  for (const statement of splitSqlStatements(sql)) {
    await client.query(statement);
  }
  await client.query('INSERT INTO migrations (name) VALUES ($1)', [migrationFile]);
}

import type { DatabaseClient } from '../clients/database-client';
import type { PoolClient } from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Get the root directory of the project (3 levels up from this file)
const currentDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(currentDir, '..', '..', '..');
export const MIGRATIONS_DIR = join(projectRoot, 'migrations');

/**
 * Advisory lock key ("hlm1" in ASCII) that serializes runMigrations. Web and
 * worker boot concurrently; without it the loser hits the migrations.name
 * unique constraint and logs a spurious error.
 */
export const MIGRATIONS_ADVISORY_LOCK_KEY = 0x686c6d31;

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
  const migrationFiles = readdirSync(MIGRATIONS_DIR)
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

    // Run migration in a transaction
    console.log(`[Migrations] Running ${migrationFile}...`);
    const migrationPath = join(MIGRATIONS_DIR, migrationFile);
    const sql = readFileSync(migrationPath, 'utf-8');

    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO migrations (name) VALUES ($1)',
        [migrationFile]
      );
      await client.query('COMMIT');
      console.log(`[Migrations] ✓ Successfully applied ${migrationFile}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[Migrations] ✗ Failed to apply ${migrationFile}:`, err);
      throw err;
    }
  }

  console.log('[Migrations] All migrations completed successfully');
}

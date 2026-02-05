import type { DatabaseClient } from '../clients/database-client';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Get the root directory of the project (3 levels up from this file)
const currentDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(currentDir, '..', '..', '..');
const migrationsDir = join(projectRoot, 'migrations');

/**
 * Run all pending database migrations
 * Migrations are applied sequentially and tracked in the migrations table
 */
export async function runMigrations(db: DatabaseClient): Promise<void> {
  const pool = db.getPool();

  // Create migrations table if it doesn't exist
  await pool.query(`
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
    const result = await pool.query(
      'SELECT 1 FROM migrations WHERE name = $1',
      [migrationFile]
    );

    if (result.rows.length > 0) {
      console.log(`[Migrations] Skipping ${migrationFile} (already applied)`);
      continue;
    }

    // Run migration in a transaction
    console.log(`[Migrations] Running ${migrationFile}...`);
    const migrationPath = join(migrationsDir, migrationFile);
    const sql = readFileSync(migrationPath, 'utf-8');

    try {
      await pool.query('BEGIN');
      await pool.query(sql);
      await pool.query(
        'INSERT INTO migrations (name) VALUES ($1)',
        [migrationFile]
      );
      await pool.query('COMMIT');
      console.log(`[Migrations] ✓ Successfully applied ${migrationFile}`);
    } catch (err) {
      await pool.query('ROLLBACK');
      console.error(`[Migrations] ✗ Failed to apply ${migrationFile}:`, err);
      throw err;
    }
  }

  console.log('[Migrations] All migrations completed successfully');
}

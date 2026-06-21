/**
 * Runs database migrations against the configured Postgres (POSTGRES_* env), then
 * exits. The web server does not auto-migrate (only the worker does), so the auth
 * e2e lane uses this to prepare the throwaway test database before the app starts.
 *
 * Usage: bun scripts/run-migrations.ts
 */
import { databaseConnectionManager } from '@/lib/clients/database-client';
import { loadDatabaseConfig } from '@/lib/config/database-config';
import { runMigrations } from '@/lib/database/migrate';

const db = await databaseConnectionManager.getClient(loadDatabaseConfig());
try {
  await runMigrations(db);
  console.info('[run-migrations] migrations applied');
} finally {
  await databaseConnectionManager.closeAll();
}

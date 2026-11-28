/** Applies migrations for the auth e2e lane, run by its seed script after the database name check, because the web server does not auto-migrate (only the worker does). */
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

/** Migrates the auth e2e lane's throwaway database, because the web server does not auto-migrate (only the worker does). */
import { databaseConnectionManager } from '@/lib/clients/database-client';
import { loadDatabaseConfig } from '@/lib/config/database-config';
import { runMigrations } from '@/lib/database/migrate';
import { assertLaneDatabase } from '../e2e/auth/lane-config';

assertLaneDatabase();

const db = await databaseConnectionManager.getClient(loadDatabaseConfig());
try {
  await runMigrations(db);
  console.info('[run-migrations] migrations applied');
} finally {
  await databaseConnectionManager.closeAll();
}

import { createMiddleware } from '@tanstack/react-start';

/**
 * Database middleware — injects a pg Pool into the server function context.
 * Dynamically imports server-only modules (pg, database-client, database-config)
 * to keep them out of the client bundle.
 *
 * `loadDatabaseConfig()` is called once at middleware creation time since the
 * config is static for the lifetime of the process.
 *
 * Usage:
 *   createServerFn()
 *     .middleware([databaseMiddleware])
 *     .handler(async ({ context }) => {
 *       const repo = new StatsRepository(context.pool);
 *       ...
 *     });
 */
const { loadDatabaseConfig } = await import('@/lib/config/database-config');
const config = loadDatabaseConfig();

export const databaseMiddleware = createMiddleware().server(
  async ({ next }) => {
    const { databaseConnectionManager } = await import(
      '@/lib/clients/database-client'
    );

    const dbClient = await databaseConnectionManager.getClient(config);

    return next({ context: { pool: dbClient.getPool() } });
  },
);

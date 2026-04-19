import { createMiddleware } from '@tanstack/react-start';

/**
 * Database middleware — injects a pg Pool into the server function context.
 * Dynamically imports server-only modules (pg, database-client, database-config)
 * to keep them out of the client bundle.
 *
 * Usage:
 *   createServerFn()
 *     .middleware([databaseMiddleware])
 *     .handler(async ({ context }) => {
 *       const repo = new StatsRepository(context.pool);
 *       ...
 *     });
 */
export const databaseMiddleware = createMiddleware().server(
  async ({ next }) => {
    const { databaseConnectionManager } = await import(
      '@/lib/clients/database-client'
    );
    const { loadDatabaseConfig } = await import(
      '@/lib/config/database-config'
    );

    const config = loadDatabaseConfig();
    const dbClient = await databaseConnectionManager.getClient(config);

    return next({ context: { pool: dbClient.getPool() } });
  },
);

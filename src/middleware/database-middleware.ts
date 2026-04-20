import { createMiddleware } from '@tanstack/react-start';
import type { DatabaseConfig } from '@/lib/clients/database-client';

let cachedConfig: DatabaseConfig | null = null;

/**
 * Database middleware: injects a pg Pool into the server function context.
 *
 * All server-only modules (`database-client`, `database-config`) are imported
 * inside the `.server()` callback so they never enter the client bundle. The
 * validated config is cached in `cachedConfig` on first request since it is
 * static for the lifetime of the process.
 *
 * Bootstrap failures (bad env, DB unreachable) are logged with a
 * `[databaseMiddleware]` prefix and re-thrown. The server function's RPC call
 * will reject on the client. Callers that previously relied on the handler's
 * `try/catch` returning `[]`/`{}`/`null` on DB outage will now receive an
 * error (intentional: silent empty fallbacks hid outages).
 *
 * Usage:
 *   createServerFn()
 *     .middleware([databaseMiddleware])
 *     .handler(async ({ context, data }) => {
 *       const repo = new StatsRepository(context.pool);
 *       ...
 *     });
 */
export const databaseMiddleware = createMiddleware().server(
  async ({ next }) => {
    try {
      if (!cachedConfig) {
        const { loadDatabaseConfig } = await import(
          '@/lib/config/database-config'
        );
        cachedConfig = loadDatabaseConfig();
      }

      const { databaseConnectionManager } = await import(
        '@/lib/clients/database-client'
      );
      const dbClient = await databaseConnectionManager.getClient(cachedConfig);

      return next({ context: { pool: dbClient.getPool() } });
    } catch (err) {
      console.error('[databaseMiddleware] DB bootstrap failed:', err);
      throw err;
    }
  },
);

/**
 * Reset cached config (for testing only).
 */
export function resetDatabaseMiddlewareState(): void {
  cachedConfig = null;
}

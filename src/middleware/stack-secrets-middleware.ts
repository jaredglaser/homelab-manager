import { createMiddleware } from '@tanstack/react-start';
import type { DatabaseConfig } from '@/lib/clients/database-client';
import type { MasterKeyring } from '@/lib/crypto/master-key';

let cachedConfig: DatabaseConfig | null = null;
let cachedKeyring: MasterKeyring | null = null;

/**
 * Stack secrets middleware: injects a pg Pool and master keyring into the server
 * function context, providing everything needed to construct a StackSecretsRepository.
 *
 * All server-only modules are imported inside the `.server()` callback. Config and
 * keyring are cached after first load since both are static for the process lifetime.
 *
 * Usage:
 *   createServerFn()
 *     .middleware([stackSecretsMiddleware])
 *     .handler(async ({ context, data }) => {
 *       const { StackSecretsRepository } = await import('...');
 *       const repo = new StackSecretsRepository(context.pool, context.keyring);
 *       ...
 *     });
 */
export const stackSecretsMiddleware = createMiddleware().server(
  async ({ next }) => {
    try {
      if (!cachedConfig) {
        const { loadDatabaseConfig } = await import('@/lib/config/database-config');
        cachedConfig = loadDatabaseConfig();
      }

      const { databaseConnectionManager } = await import('@/lib/clients/database-client');
      const dbClient = await databaseConnectionManager.getClient(cachedConfig);

      if (!cachedKeyring) {
        const { loadMasterKeyring } = await import('@/lib/crypto/master-key');
        cachedKeyring = await loadMasterKeyring();
      }

      return next({ context: { pool: dbClient.getPool(), keyring: cachedKeyring } });
    } catch (err) {
      console.error('[stackSecretsMiddleware] Bootstrap failed:', err);
      throw err;
    }
  },
);

export function resetStackSecretsMiddlewareState(): void {
  cachedConfig = null;
  cachedKeyring = null;
}

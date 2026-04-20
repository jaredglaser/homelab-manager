import { createMiddleware } from '@tanstack/react-start';
import {
  getOpenBaoClient,
  resetOpenBaoClientCache,
} from '@/lib/clients/openbao-client-factory';

/**
 * OpenBao middleware: injects an OpenBaoClient into the server function context.
 * Delegates to the shared client factory so the cache is unified with any
 * server functions that call getOpenBaoClient() directly.
 */
export const openBaoMiddleware = createMiddleware().server(
  async ({ next }) => {
    const client = await getOpenBaoClient();
    return next({ context: { openBaoClient: client } });
  },
);

/**
 * Reset cached client (for testing only).
 * Delegates to the factory cache that backs this middleware.
 */
export function resetOpenBaoMiddlewareState(): void {
  resetOpenBaoClientCache();
}

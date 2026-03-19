import { createMiddleware } from '@tanstack/react-start';
import type { OpenBaoClient } from '@/lib/clients/openbao-client';

/**
 * OpenBao middleware — injects an OpenBaoClient into the server function context.
 * Dynamically imports server-only modules to avoid leaking into the client bundle.
 * Runs initializeOpenBao on first use to ensure the KV v2 engine is enabled.
 */
export const openBaoMiddleware = createMiddleware().server(
  async ({ next }) => {
    const { isOpenBaoConfigured, loadOpenBaoConfig } = await import(
      '@/lib/config/openbao-config'
    );

    if (!isOpenBaoConfigured()) {
      throw new Error('OpenBao is not configured');
    }

    const config = loadOpenBaoConfig();
    const { OpenBaoClient: Client } = await import(
      '@/lib/clients/openbao-client'
    );
    const client: OpenBaoClient = new Client(config);

    // Initialize on first use (promise-based singleton prevents race conditions)
    const { initializeOpenBao } = await import(
      '@/lib/services/openbao-init'
    );
    await initializeOpenBao(client);

    return next({ context: { openBaoClient: client } });
  },
);

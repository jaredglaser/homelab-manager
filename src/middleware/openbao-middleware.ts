import { createMiddleware } from '@tanstack/react-start';
import type { OpenBaoClient } from '@/lib/clients/openbao-client';

let cachedClient: OpenBaoClient | null = null;

/**
 * OpenBao middleware — injects an OpenBaoClient into the server function context.
 * Dynamically imports server-only modules to avoid leaking into the client bundle.
 * Runs initializeOpenBao on first use to ensure the KV v2 engine is enabled.
 * Caches the client as a singleton since it is stateless (same URL/token across requests).
 */
export const openBaoMiddleware = createMiddleware().server(
  async ({ next }) => {
    const { isOpenBaoConfigured, loadOpenBaoConfig } = await import(
      '@/lib/config/openbao-config'
    );

    if (!isOpenBaoConfigured()) {
      const hasUrl = !!process.env.OPENBAO_URL;
      const hasToken = !!process.env.OPENBAO_TOKEN;
      const missing = [
        !hasUrl && 'OPENBAO_URL',
        !hasToken && 'OPENBAO_TOKEN',
      ].filter(Boolean).join(', ');
      throw new Error(`OpenBao is not configured (missing: ${missing})`);
    }

    if (!cachedClient) {
      const config = loadOpenBaoConfig();
      const { OpenBaoClient: Client } = await import(
        '@/lib/clients/openbao-client'
      );
      cachedClient = new Client(config);
    }

    const { initializeOpenBao } = await import(
      '@/lib/services/openbao-init'
    );
    await initializeOpenBao(cachedClient);

    return next({ context: { openBaoClient: cachedClient } });
  },
);

/**
 * Reset cached client (for testing only).
 */
export function resetOpenBaoMiddlewareState(): void {
  cachedClient = null;
}

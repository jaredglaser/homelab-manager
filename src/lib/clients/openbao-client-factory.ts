import type { OpenBaoClient } from '@/lib/clients/openbao-client';

/**
 * Single module-scoped OpenBaoClient cache shared by the openBaoMiddleware
 * and any server-function call sites that need a client directly. Keeping one
 * cache here avoids duplicate `initializeOpenBao` work and ensures cache
 * invalidation stays consistent across the app.
 *
 * All imports of server-only modules are dynamic so this file can be
 * transitively reachable from client bundles without pulling them in.
 */
let cachedClient: OpenBaoClient | null = null;

/**
 * Get the shared OpenBaoClient singleton. Throws if OpenBao is not configured
 * (missing OPENBAO_URL or OPENBAO_TOKEN). Runs initializeOpenBao on first use
 * to ensure the KV v2 engine is enabled. Subsequent calls reuse the cached
 * client and the init guard in initializeOpenBao makes repeat calls cheap.
 */
export async function getOpenBaoClient(): Promise<OpenBaoClient> {
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

  const { initializeOpenBao } = await import('@/lib/services/openbao-init');
  await initializeOpenBao(cachedClient);

  return cachedClient;
}

/**
 * Reset cached client (for testing only).
 */
export function resetOpenBaoClientCache(): void {
  cachedClient = null;
}

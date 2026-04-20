import type { OpenBaoClient } from '@/lib/clients/openbao-client';

let initPromise: Promise<void> | null = null;

/**
 * Initialize OpenBao for first use.
 * Ensures the KV v2 secrets engine is enabled at the `secret/` path.
 * Safe to call multiple times: uses a promise-based singleton to prevent
 * race conditions when concurrent requests arrive simultaneously.
 * The first call creates the initialization promise; subsequent calls await it.
 */
export async function initializeOpenBao(client: OpenBaoClient): Promise<void> {
  if (initPromise) {
    return initPromise;
  }

  initPromise = client.ensureSecretsEngine().catch((error) => {
    // Reset so next call retries instead of returning a rejected promise
    initPromise = null;
    console.error(
      'Failed to initialize OpenBao secrets engine:',
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  });

  return initPromise;
}

/**
 * Reset initialization state (for testing only).
 */
export function resetOpenBaoInitState(): void {
  initPromise = null;
}

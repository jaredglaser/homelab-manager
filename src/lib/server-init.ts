import { notifyService } from '@/lib/database/subscription-service';
import { databaseConnectionManager } from '@/lib/clients/database-client';

let initialized = false;

/**
 * Initialize server-side resources and set up shutdown handlers.
 * This is idempotent - safe to call multiple times.
 */
export function initServer(): void {
  if (initialized) return;
  initialized = true;

  const shutdown = async () => {
    console.log('[Server] Shutdown signal received, cleaning up...');

    try {
      await notifyService.stop();
      await databaseConnectionManager.closeAll();

      console.log('[Server] Cleanup complete');
      process.exit(0);
    } catch (err) {
      console.error('[Server] Error during cleanup:', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log('[Server] Shutdown handlers registered');
}

// Auto-initialize when this module is imported on the server
if (typeof window === 'undefined') {
  initServer();
}

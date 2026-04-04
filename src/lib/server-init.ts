import { statsPollService } from '@/lib/database/subscription-service';
import { settingsBroadcastService } from '@/lib/settings/settings-broadcast-service';
import { stackStatusBroadcastService } from '@/lib/stacks/stack-status-broadcast-service';
import { databaseConnectionManager } from '@/lib/clients/database-client';

let initialized = false;

/**
 * Initialize server-side resources and register shutdown handlers.
 *
 * This function is idempotent: if initialization has already occurred it returns immediately.
 * It registers handlers for SIGTERM and SIGINT that stop the stats poller, stop the settings
 * broadcast service, and close all database connections; on successful cleanup the process
 * exits with code 0, and on error it exits with code 1.
 */
export function initServer(): void {
  if (initialized) return;
  initialized = true;

  const shutdown = async () => {
    console.log('[Server] Shutdown signal received, cleaning up...');

    try {
      await statsPollService.stop();
      await settingsBroadcastService.stop();
      await stackStatusBroadcastService.stop();
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

import { statsPollService } from '@/lib/database/subscription-service';
import { settingsBroadcastService } from '@/lib/settings/settings-broadcast-service';
import { stackStatusBroadcastService } from '@/lib/stacks/stack-status-broadcast-service';
import { databaseConnectionManager } from '@/lib/clients/database-client';
import { DeployWatchdog } from '@/lib/deploy/deploy-watchdog';

let initialized = false;
const deployWatchdog = new DeployWatchdog();

const STARTUP_RECOVERY_MESSAGE =
  'Deploy interrupted — server restarted while this deploy was in progress. The actual outcome on the host is unknown. Please verify stack status and re-trigger if needed.';

/** Startup recovery + watchdog. Fire-and-forget; errors are logged and non-fatal. */
async function startDeployRecovery(): Promise<void> {
  const { databaseConnectionManager: dbm } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { DeployRepository } = await import('@/lib/database/repositories/deploy-repository');

  const dbClient = await dbm.getClient(loadDatabaseConfig());
  const repo = new DeployRepository(dbClient.getPool());

  const recovered = await repo.recoverStuckDeploys(STARTUP_RECOVERY_MESSAGE);
  if (recovered.length > 0) {
    console.info(`[Server] Recovered ${recovered.length} stuck deploy(s) on startup`);
    for (const r of recovered) {
      try {
        await repo.notifyStackChange(r.stack, r.host);
      } catch (err) {
        console.error(`[Server] Failed to notify stack change for ${r.stack}/${r.host}:`, err);
      }
    }
  }

  deployWatchdog.start(repo);
}

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
    console.info('[Server] Shutdown signal received, cleaning up...');

    try {
      deployWatchdog.stop();
      await statsPollService.stop();
      await settingsBroadcastService.stop();
      await stackStatusBroadcastService.stop();
      await databaseConnectionManager.closeAll();

      console.info('[Server] Cleanup complete');
      process.exit(0);
    } catch (err) {
      console.error('[Server] Error during cleanup:', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  startDeployRecovery().catch((err) => {
    console.error('[Server] Deploy recovery / watchdog startup failed:', err);
  });

  console.info('[Server] Shutdown handlers registered');
}

// Auto-initialize when this module is imported on the server
if (typeof window === 'undefined') {
  initServer();
}

import { statsPollService } from '@/lib/database/subscription-service';
import { settingsBroadcastService } from '@/lib/settings/settings-broadcast-service';
import { stackStatusBroadcastService } from '@/lib/stacks/stack-status-broadcast-service';
import { databaseConnectionManager } from '@/lib/clients/database-client';
import { DeployWatchdog } from '@/lib/deploy/deploy-watchdog';

let initialized = false;
const deployWatchdog = new DeployWatchdog();

async function startDeployRecovery(): Promise<void> {
  const { databaseConnectionManager: dbm } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { DeployRepository } = await import('@/lib/database/repositories/deploy-repository');
  const { performStartupRecovery } = await import('@/lib/deploy/startup-recovery');

  const dbClient = await dbm.getClient(loadDatabaseConfig());
  const repo = new DeployRepository(dbClient.getPool());

  await performStartupRecovery(repo, deployWatchdog);
}

/** Idempotent. Registers SIGTERM/SIGINT shutdown handlers and kicks off deploy recovery. */
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

if (typeof window === 'undefined') {
  initServer();
}

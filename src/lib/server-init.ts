import { enforceAuthConfig } from '@/lib/config/auth-config';
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
  const { createStackRepoWriter } = await import('@/lib/deploy/stack-repo-writer');
  const { loadGitConfig } = await import('@/lib/config/git-config');
  const { readFileFromRepo } = await import('@/lib/git/repo');
  const { parseManifest } = await import('@/lib/git/manifest');
  const { MANIFEST } = await import('@/lib/stacks/stack-repo-layout');

  const dbClient = await dbm.getClient(loadDatabaseConfig());
  const repo = new DeployRepository(dbClient.getPool());

  const manifestReader = {
    async listStackNames(): Promise<Set<string>> {
      try {
        const { repoPath } = loadGitConfig();
        const content = await readFileFromRepo(repoPath, MANIFEST);
        return new Set(Object.keys(parseManifest(content).stacks));
      } catch {
        // No repo, no manifest, nothing to orphan-sweep against.
        return new Set();
      }
    },
  };

  await performStartupRecovery(repo, deployWatchdog, {
    manifestReader,
    stackRepoWriter: createStackRepoWriter(),
  });
}

/** Idempotent. Registers SIGTERM/SIGINT shutdown handlers and kicks off deploy recovery. */
export function initServer(): void {
  if (initialized) return;

  // Validate before setting the flag so a misconfigured process keeps failing
  // on every init attempt instead of throwing once and then serving requests.
  enforceAuthConfig();

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

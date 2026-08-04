import { enforceAuthConfig } from '@/lib/config/auth-config';
import { statsPollService } from '@/lib/database/subscription-service';
import { settingsBroadcastService } from '@/lib/settings/settings-broadcast-service';
import { stackStatusBroadcastService } from '@/lib/stacks/stack-status-broadcast-service';
import { databaseConnectionManager } from '@/lib/clients/database-client';
import { DeployWatchdog } from '@/lib/deploy/deploy-watchdog';
import { AnsibleRunWatchdog } from '@/lib/ansible/run-watchdog';

let initialized = false;
const deployWatchdog = new DeployWatchdog();
const ansibleRunWatchdog = new AnsibleRunWatchdog();

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

async function startStatsRollupBackfill(): Promise<void> {
  const { databaseConnectionManager: dbm } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { runStatsRollupBackfill } = await import('@/lib/database/stats-rollup-backfill');

  const dbClient = await dbm.getClient(loadDatabaseConfig());
  await runStatsRollupBackfill(dbClient);
}

async function startGitTokenHashBackfill(): Promise<void> {
  const { databaseConnectionManager: dbm } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { GitTokenRepository } = await import('@/lib/database/repositories/git-token-repository');
  const { backfillGitTokenHashes } = await import('@/lib/git/git-token-auth');
  const { loadMasterKeyring } = await import('@/lib/crypto/master-key');
  const { decryptValue } = await import('@/lib/crypto/encrypted-value');

  const dbClient = await dbm.getClient(loadDatabaseConfig());
  const repo = new GitTokenRepository(dbClient.getPool());

  // loadMasterKeyring re-reads env and re-imports every key per call, so one
  // promise covers the whole backfill.
  let keyring: ReturnType<typeof loadMasterKeyring> | null = null;

  await backfillGitTokenHashes(repo, async (encryptedToken) => {
    keyring ??= loadMasterKeyring();
    return decryptValue(encryptedToken, await keyring);
  });
}

async function startAnsibleRunRecovery(): Promise<void> {
  const { isAnsibleEnabled } = await import('@/lib/config/ansible-config');
  if (!isAnsibleEnabled()) return;

  const { databaseConnectionManager: dbm } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { AnsibleRunRepository } = await import(
    '@/lib/database/repositories/ansible-run-repository'
  );
  const { performAnsibleRunRecovery } = await import('@/lib/ansible/startup-recovery');
  const { ansibleRunBroadcastService } = await import('@/lib/ansible/run-broadcast-service');

  const dbClient = await dbm.getClient(loadDatabaseConfig());
  const repo = new AnsibleRunRepository(dbClient.getPool());

  await performAnsibleRunRecovery(repo, ansibleRunWatchdog, (event) => {
    ansibleRunBroadcastService.publish(event);
  });
}

/**
 * Idempotent. Registers SIGTERM/SIGINT shutdown handlers and kicks off deploy
 * recovery, the stats rollup backfill, and the git token hash backfill.
 */
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
      ansibleRunWatchdog.stop();
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

  startStatsRollupBackfill().catch((err) => {
    console.error('[Server] Stats rollup backfill failed:', err);
  });

  startGitTokenHashBackfill().catch((err) => {
    console.error('[Server] Git token hash backfill failed:', err);
  });

  startAnsibleRunRecovery().catch((err) => {
    console.error('[Server] Ansible run recovery failed:', err);
  });

  console.info('[Server] Shutdown handlers registered');
}

if (typeof window === 'undefined') {
  initServer();
}

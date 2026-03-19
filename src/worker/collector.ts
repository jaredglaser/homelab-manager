import { databaseConnectionManager } from '@/lib/clients/database-client';
import { dockerConnectionManager } from '@/lib/clients/docker-client';
import { proxmoxConnectionManager } from '@/lib/clients/proxmox-client';
import { sshConnectionManager } from '@/lib/clients/ssh-client';
import { loadDatabaseConfig } from '@/lib/config/database-config';
import { loadWorkerConfig } from '@/lib/config/worker-config';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';
import { runMigrations } from '@/lib/database/migrate';
import { SettingsRepository } from '@/lib/database/repositories/settings-repository';
import { isDockerManagementEnabled } from '@/lib/config/feature-flags';
import { HostRepository } from '@/lib/database/repositories/host-repository';
import { ProxmoxCollector } from './collectors/proxmox-collector';
import { createCollectors, createCollectorsForManagedHosts } from './collector-factory';
import { resolveCollectionInterval } from './resolve-collection-interval';
import { SettingsListener } from './settings-listener';

/**
 * Start and run the background worker that coordinates collectors, database migrations, settings updates, and graceful shutdown.
 *
 * Loads configuration and database connection, runs migrations, resolves collection and Proxmox poll intervals, creates and runs enabled collectors, and listens for settings changes (developer/dockerDebugLogging, developer/dbFlushDebugLogging, proxmox/updateInterval) to adjust collector behavior at runtime. Handles SIGTERM/SIGINT to abort collectors and performs orderly cleanup of connections; on unrecoverable errors the process exits with a non-zero code.
 */
async function main() {
  console.log('[Worker] Starting homelab-manager background collector');

  try {
    const dbConfig = loadDatabaseConfig();
    const workerConfig = loadWorkerConfig();

    if (!workerConfig.enabled) {
      console.log('[Worker] Worker disabled via WORKER_ENABLED=false, exiting');
      process.exit(0);
    }

    console.log('[Worker] Configuration loaded:', {
      database: `${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`,
      docker: workerConfig.docker.enabled,
      zfs: workerConfig.zfs.enabled,
      proxmox: workerConfig.proxmox.enabled,
      collectionInterval: `${workerConfig.collection.interval}ms`,
    });

    console.log('[Worker] Connecting to PostgreSQL...');
    const db = await databaseConnectionManager.getClient(dbConfig);

    console.log('[Worker] Running database migrations...');
    await runMigrations(db);

    // Override collection interval from database if configured
    const settingsRepo = new SettingsRepository(db.getPool());
    const resolvedInterval = await resolveCollectionInterval(settingsRepo, workerConfig.collection.interval);
    if (resolvedInterval !== workerConfig.collection.interval) {
      workerConfig.collection.interval = resolvedInterval;
      console.log(`[Worker] Using update interval from database: ${resolvedInterval}ms`);
    } else {
      console.log(`[Worker] Using update interval from config: ${workerConfig.collection.interval}ms`);
    }

    // Resolve Proxmox poll interval from DB settings (default 10s)
    let proxmoxPollIntervalMs = 10_000;
    try {
      const raw = await settingsRepo.get(SETTINGS_KEYS.proxmox.updateInterval);
      const parsed = raw ? parseInt(raw, 10) : 10_000;
      if (parsed === 1000 || parsed === 10000) proxmoxPollIntervalMs = parsed;
    } catch (err) {
      console.error('[Worker] Failed to read Proxmox poll interval from settings, using default:', err instanceof Error ? err.message : err);
    }

    // Shared AbortController - SIGTERM aborts all collectors instantly
    const shutdownController = new AbortController();

    const shutdown = () => {
      console.log('[Worker] Shutdown signal received, aborting collectors...');
      shutdownController.abort(new DOMException('Shutdown', 'AbortError'));
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    // Use AsyncDisposableStack for automatic cleanup of optional collectors
    {
      await using stack = new AsyncDisposableStack();

      const { collectors, runners } = createCollectors(db, workerConfig, shutdownController, stack, proxmoxPollIntervalMs);

      // Also start AgentStatsCollectors for managed hosts (if feature flag is on)
      const hostRepo = new HostRepository(db.getPool());
      let getToken: ((hostname: string) => Promise<string | null>) | undefined;

      if (isDockerManagementEnabled()) {
        const { loadOpenBaoConfig } = await import('@/lib/config/openbao-config');
        const { OpenBaoClient } = await import('@/lib/clients/openbao-client');
        const baoConfig = loadOpenBaoConfig(); // throws ZodError if env vars missing
        const baoClient = new OpenBaoClient(baoConfig);
        await baoClient.ensureSecretsEngine();
        console.info('[Worker] OpenBao client initialized for managed host tokens');
        getToken = (hostname: string) => baoClient.getHostSecret(hostname, 'agent_token');
      }

      const { collectors: managedCollectors, runners: managedRunners } = await createCollectorsForManagedHosts(
        db, workerConfig, shutdownController, stack,
        isDockerManagementEnabled,
        () => hostRepo.findAll(),
        getToken ?? (() => Promise.resolve(null)),
      );
      collectors.push(...managedCollectors);
      runners.push(...managedRunners);

      if (runners.length === 0) {
        console.log('[Worker] No collectors enabled, exiting');
        process.exit(0);
      }

      // Listen for debug logging + proxmox interval setting changes
      const settingsListener = stack.use(
        new SettingsListener(
          dbConfig,
          settingsRepo,
          [
            SETTINGS_KEYS.developer.dockerDebugLogging,
            SETTINGS_KEYS.developer.dbFlushDebugLogging,
            SETTINGS_KEYS.proxmox.updateInterval,
          ],
          (key, value) => {
            if (key === SETTINGS_KEYS.developer.dockerDebugLogging) {
              const enabled = value === 'true';
              for (const c of collectors) c.dockerDebugLogging = enabled;
              dockerConnectionManager.debugLogging = enabled;
            } else if (key === SETTINGS_KEYS.developer.dbFlushDebugLogging) {
              const enabled = value === 'true';
              for (const c of collectors) c.dbFlushDebugLogging = enabled;
            } else if (key === SETTINGS_KEYS.proxmox.updateInterval) {
              const parsed = value ? parseInt(value, 10) : 10_000;
              const interval = (parsed === 1000 || parsed === 10000) ? parsed : 10_000;
              for (const c of collectors) {
                if (c instanceof ProxmoxCollector) {
                  c.pollInterval = interval;
                }
              }
            }
          },
          shutdownController.signal,
        )
      );
      await settingsListener.start();

      console.log(`[Worker] ${runners.length} collector(s) started, running...`);
      await Promise.all(runners);
    }
    // AsyncDisposableStack disposes here - cleans up

    console.log('[Worker] Closing connections...');
    proxmoxConnectionManager.clearAll();
    await Promise.all([
      databaseConnectionManager.closeAll(),
      dockerConnectionManager.closeAll(),
      sshConnectionManager.closeAll(),
    ]);

    console.log('[Worker] Shutdown complete');
  } catch (err) {
    console.error('[Worker] Fatal error:', err);
    process.exit(1);
  }
}

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.error('[Worker] Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Worker] Unhandled rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

main();

import { databaseConnectionManager } from '@/lib/clients/database-client';
import { proxmoxConnectionManager } from '@/lib/clients/proxmox-client';
import { loadDatabaseConfig } from '@/lib/config/database-config';
import { loadWorkerConfig } from '@/lib/config/worker-config';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';
import { runMigrations } from '@/lib/database/migrate';
import { SettingsRepository } from '@/lib/database/repositories/settings-repository';
import { HostRepository } from '@/lib/database/repositories/host-repository';
import type { BaseCollector } from './collectors/base-collector';
import { ProxmoxCollector } from './collectors/proxmox-collector';
import { createCollectors } from './collector-factory';
import { HostCollectorManager, defaultHostCollectorFactory } from './host-collector-manager';
import { HostsListener } from './hosts-listener';
import { resolveCollectionInterval } from './resolve-collection-interval';
import { SettingsListener } from './settings-listener';

function handleSettingChange(getCollectors: () => BaseCollector[], key: string, value: string | null): void {
  const collectors = getCollectors();
  if (key === SETTINGS_KEYS.developer.dockerDebugLogging) {
    const enabled = value === 'true';
    for (const c of collectors) c.dockerDebugLogging = enabled;
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
}

/**
 * Start and run the background worker that coordinates collectors, database migrations, settings updates, and graceful shutdown.
 *
 * Loads configuration and database connection, runs migrations, resolves collection and Proxmox poll intervals, creates and runs enabled collectors, and listens for settings changes (developer/dockerDebugLogging, developer/dbFlushDebugLogging, proxmox/updateInterval) to adjust collector behavior at runtime. Handles SIGTERM/SIGINT to abort collectors and performs orderly cleanup of connections; on unrecoverable errors the process exits with a non-zero code.
 */
async function main() {
  console.info('[Worker] Starting homelab-manager background collector');

  try {
    const dbConfig = loadDatabaseConfig();
    const workerConfig = loadWorkerConfig();

    console.info('[Worker] Configuration loaded:', {
      database: `${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`,
      docker: workerConfig.docker.enabled,
      zfs: workerConfig.zfs.enabled,
      proxmox: workerConfig.proxmox.enabled,
      collectionInterval: `${workerConfig.collection.interval}ms`,
    });

    console.info('[Worker] Connecting to PostgreSQL...');
    const db = await databaseConnectionManager.getClient(dbConfig);

    console.info('[Worker] Running database migrations...');
    await runMigrations(db);

    // Auto-seed localhost agent in dev mode (gated by DEV_AGENT_TOKEN env var)
    const { seedDevAgent } = await import('./dev-seed');
    await seedDevAgent(db);

    // Override collection interval from database if configured
    const settingsRepo = new SettingsRepository(db.getPool());
    const resolvedInterval = await resolveCollectionInterval(settingsRepo, workerConfig.collection.interval);
    if (resolvedInterval !== workerConfig.collection.interval) {
      workerConfig.collection.interval = resolvedInterval;
      console.info(`[Worker] Using update interval from database: ${resolvedInterval}ms`);
    } else {
      console.info(`[Worker] Using update interval from config: ${workerConfig.collection.interval}ms`);
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
      console.info('[Worker] Shutdown signal received, aborting collectors...');
      shutdownController.abort(new DOMException('Shutdown', 'AbortError'));
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    // Use AsyncDisposableStack for automatic cleanup of optional collectors
    {
      await using stack = new AsyncDisposableStack();

      const { collectors: staticCollectors, runners: staticRunners } = createCollectors(
        db, workerConfig, shutdownController, stack, proxmoxPollIntervalMs,
      );

      const hostRepo = new HostRepository(db.getPool());

      const { AgentKeypairsRepository } = await import('@/lib/database/repositories/agent-keypairs-repository');
      const { loadMasterKeyring } = await import('@/lib/crypto/master-key');
      const { signAgentJwt } = await import('@/lib/crypto/agent-jwt');
      const keyring = await loadMasterKeyring();
      const keypairs = new AgentKeypairsRepository(db.getPool(), keyring);
      const getSigner = async (hostname: string): Promise<(() => Promise<string>) | null> => {
        const privateKey = await keypairs.getPrivateKeyForHost(hostname);
        if (!privateKey) return null;
        return () => signAgentJwt(privateKey, hostname);
      };

      // Manager owns the per-host collector lifecycle. Reconciles on every
      // managed_hosts NOTIFY so adding/removing hosts in the UI takes effect
      // without restarting the worker.
      const hostManager = stack.use(
        new HostCollectorManager(
          workerConfig,
          shutdownController.signal,
          () => hostRepo.findAll(),
          getSigner,
          defaultHostCollectorFactory(db, workerConfig),
        ),
      );

      // Start LISTEN before the initial reconcile. If we reconciled first,
      // a NOTIFY arriving in the gap between findAll() and listener.start()
      // would be dropped. With LISTEN active first, any NOTIFY during the
      // initial reconcile triggers a follow-up reconcile that serialises
      // through the manager's promise chain.
      const hostsListener = stack.use(
        new HostsListener(
          dbConfig,
          () => hostManager.reconcile(),
          shutdownController.signal,
        ),
      );
      await hostsListener.start();
      await hostManager.reconcile();

      // Worker stays alive even with zero collectors initially: a host added
      // through the wizard later will spin up its collectors via the listener.
      const initialRunners = [...staticRunners, ...hostManager.runners()];
      const initialCollectors = [...staticCollectors, ...hostManager.collectors()];
      if (initialRunners.length === 0 && initialCollectors.length === 0 && hostManager.hostNames().length === 0) {
        console.info('[Worker] No collectors active yet; waiting for managed hosts to be registered');
      } else {
        console.info(`[Worker] ${initialRunners.length} collector(s) started, ${hostManager.hostNames().length} managed host(s) online`);
      }

      // Listen for debug logging + proxmox interval setting changes. Pulls
      // the current collector set on each event so dynamically added host
      // collectors also pick up new settings.
      const settingsListener = stack.use(
        new SettingsListener(
          dbConfig,
          settingsRepo,
          [
            SETTINGS_KEYS.developer.dockerDebugLogging,
            SETTINGS_KEYS.developer.dbFlushDebugLogging,
            SETTINGS_KEYS.proxmox.updateInterval,
          ],
          (key, value) => handleSettingChange(
            () => [...staticCollectors, ...hostManager.collectors()],
            key,
            value,
          ),
          shutdownController.signal,
        )
      );
      await settingsListener.start();

      // AI log analysis is opt-in and must never block startup: a bad endpoint
      // or an unreadable master key leaves the rest of the worker collecting.
      let aiRunners: Promise<void>[] = [];
      try {
        const { startFleetLogAnalysis } = await import('@/worker/ai/start-fleet-log-analysis');
        const fleetAnalysis = await startFleetLogAnalysis({
          db,
          getSigner,
          signal: shutdownController.signal,
        });
        if (fleetAnalysis) {
          stack.use(fleetAnalysis.manager);
          aiRunners = fleetAnalysis.runners;
        }
      } catch (err) {
        console.error('[Worker] AI log analysis failed to start:', err instanceof Error ? err.message : err);
      }

      // Block here until shutdown is signalled, then drain everything that's
      // running at the time. Drainage is a snapshot: anything spawned later
      // is bound to the same global signal and will resolve on its own.
      await new Promise<void>((resolve) => {
        if (shutdownController.signal.aborted) {
          resolve();
          return;
        }
        shutdownController.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      await Promise.allSettled([...staticRunners, ...hostManager.runners(), ...aiRunners]);
    }
    // AsyncDisposableStack disposes here - cleans up

    console.info('[Worker] Closing connections...');
    proxmoxConnectionManager.clearAll();
    await databaseConnectionManager.closeAll();

    console.info('[Worker] Shutdown complete');
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

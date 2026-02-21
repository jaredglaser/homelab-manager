import { Client } from 'pg';
import { databaseConnectionManager } from '@/lib/clients/database-client';
import { dockerConnectionManager } from '@/lib/clients/docker-client';
import { sshConnectionManager } from '@/lib/clients/ssh-client';
import { loadDatabaseConfig } from '@/lib/config/database-config';
import { loadDockerConfig } from '@/lib/config/docker-config';
import { loadWorkerConfig } from '@/lib/config/worker-config';
import { runMigrations } from '@/lib/database/migrate';
import { SettingsRepository } from '@/lib/database/repositories/settings-repository';
import type { BaseCollector } from './collectors/base-collector';
import { DockerCollector } from './collectors/docker-collector';
import { ZFSCollector } from './collectors/zfs-collector';

/**
 * Background worker entry point
 * Orchestrates Docker and ZFS collectors, runs migrations, handles graceful shutdown
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
      collectionInterval: `${workerConfig.collection.interval}ms`,
    });

    console.log('[Worker] Connecting to PostgreSQL...');
    const db = await databaseConnectionManager.getClient(dbConfig);

    console.log('[Worker] Running database migrations...');
    await runMigrations(db);

    // Read update interval from database settings (overrides env var)
    const settingsRepo = new SettingsRepository(db.getPool());
    try {
      const updateIntervalSetting = await settingsRepo.get('general/updateIntervalMs');
      if (updateIntervalSetting !== null) {
        const parsedInterval = parseInt(updateIntervalSetting, 10);
        if (Number.isFinite(parsedInterval) && parsedInterval >= 100 && parsedInterval <= 60000) {
          workerConfig.collection.interval = parsedInterval;
          console.log(`[Worker] Using update interval from database: ${parsedInterval}ms`);
        }
      }
    } catch {
      // DB read failed or setting doesn't exist — use env var/default
      console.log(`[Worker] Using update interval from config: ${workerConfig.collection.interval}ms`);
    }

    // Shared AbortController — SIGTERM aborts all collectors instantly
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
      const runners: Promise<void>[] = [];
      const allCollectors: BaseCollector[] = [];

      if (workerConfig.docker.enabled) {
        const dockerConfig = loadDockerConfig();

        if (dockerConfig.hosts.length === 0) {
          console.log('[Worker] Docker enabled but no hosts configured');
        } else {
          console.log(`[Worker] Starting ${dockerConfig.hosts.length} Docker collector(s)`);

          for (const hostConfig of dockerConfig.hosts) {
            console.log(`[Worker] Starting Docker collector for ${hostConfig.name}`);
            const collector = stack.use(
              new DockerCollector(db, workerConfig, hostConfig, shutdownController)
            );
            allCollectors.push(collector);
            runners.push(collector.run());
          }
        }
      } else {
        console.log('[Worker] Docker collector disabled');
      }

      if (workerConfig.zfs.enabled) {
        console.log('[Worker] Starting ZFS collector');
        const collector = stack.use(new ZFSCollector(db, workerConfig, shutdownController));
        allCollectors.push(collector);
        runners.push(collector.run());
      } else {
        console.log('[Worker] ZFS collector disabled');
      }

      if (runners.length === 0) {
        console.log('[Worker] No collectors enabled, exiting');
        process.exit(0);
      }

      // Read initial debug logging settings and LISTEN for changes
      // (settingsRepo already initialized above for reading update interval)
      const debugSettingKeys = ['developer/dockerDebugLogging', 'developer/dbFlushDebugLogging'] as const;

      const applyDebugSetting = (key: string, value: string | null) => {
        const enabled = value === 'true';
        if (key === 'developer/dockerDebugLogging') {
          for (const c of allCollectors) c.dockerDebugLogging = enabled;
          dockerConnectionManager.debugLogging = enabled;
        } else if (key === 'developer/dbFlushDebugLogging') {
          for (const c of allCollectors) c.dbFlushDebugLogging = enabled;
        }
      };

      try {
        for (const key of debugSettingKeys) {
          applyDebugSetting(key, await settingsRepo.get(key));
        }
      } catch {
        // DB read failed — keep defaults (off)
      }

      const listenClient = new Client({
        host: dbConfig.host,
        port: dbConfig.port,
        database: dbConfig.database,
        user: dbConfig.user,
        password: dbConfig.password,
      });
      await listenClient.connect();
      await listenClient.query('LISTEN settings_change');

      listenClient.on('notification', async (msg) => {
        if (msg.payload && debugSettingKeys.includes(msg.payload as any)) {
          try {
            applyDebugSetting(msg.payload, await settingsRepo.get(msg.payload));
          } catch {
            // DB read failed — keep current value
          }
        }
      });

      listenClient.on('error', (err) => {
        console.error('[Worker] Settings LISTEN connection error:', err);
      });

      shutdownController.signal.addEventListener('abort', () => {
        listenClient.end().catch(() => {});
      });

      console.log(`[Worker] ${runners.length} collector(s) started, running...`);
      await Promise.all(runners);
    }
    // AsyncDisposableStack disposes here — cleans up

    console.log('[Worker] Closing connections...');
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

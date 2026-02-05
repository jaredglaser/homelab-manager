import { databaseConnectionManager } from '@/lib/clients/database-client';
import { dockerConnectionManager } from '@/lib/clients/docker-client';
import { sshConnectionManager } from '@/lib/clients/ssh-client';
import { loadDatabaseConfig } from '@/lib/config/database-config';
import { loadWorkerConfig } from '@/lib/config/worker-config';
import { runMigrations } from '@/lib/database/migrate';
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
      batchSize: workerConfig.batch.size,
    });

    console.log('[Worker] Connecting to PostgreSQL...');
    const db = await databaseConnectionManager.getClient(dbConfig);

    console.log('[Worker] Running database migrations...');
    await runMigrations(db);

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

      if (workerConfig.docker.enabled) {
        console.log('[Worker] Starting Docker collector');
        const collector = stack.use(new DockerCollector(db, workerConfig, shutdownController));
        runners.push(collector.run());
      } else {
        console.log('[Worker] Docker collector disabled');
      }

      if (workerConfig.zfs.enabled) {
        console.log('[Worker] Starting ZFS collector');
        const collector = stack.use(new ZFSCollector(db, workerConfig, shutdownController));
        runners.push(collector.run());
      } else {
        console.log('[Worker] ZFS collector disabled');
      }

      if (runners.length === 0) {
        console.log('[Worker] No collectors enabled, exiting');
        process.exit(0);
      }

      console.log(`[Worker] ${runners.length} collector(s) started, running...`);
      await Promise.all(runners);
    }
    // AsyncDisposableStack disposes here — flushes batches, cleans up

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

import { createServerFn } from '@tanstack/react-start';
import type { ZFSStatsFromDB } from '@/lib/transformers/zfs-transformer';

/**
 * Stream ZFS stats from the database via PostgreSQL LISTEN/NOTIFY.
 * Uses the shared stats cache updated by the subscription service.
 */
export const streamZFSStatsFromDB = createServerFn()
  .handler(async function* (): AsyncGenerator<ZFSStatsFromDB[]> {
    // Dynamic imports to avoid bundling server-only code into client
    // Also initializes server-side shutdown handlers
    await import('@/lib/server-init');
    const { subscriptionService } = await import('@/lib/database/subscription-service');
    const { statsCache } = await import('@/lib/cache/stats-cache');

    // Ensure subscription service is running
    await subscriptionService.start();

    // Yield initial state from cache
    const initialStats = statsCache.getZFS();
    if (initialStats.length > 0) {
      yield initialStats;
    }

    // Wait for updates and yield stats
    while (true) {
      await new Promise<void>(resolve => {
        const handler = (source: string) => {
          if (source === 'zfs') {
            subscriptionService.removeListener('stats_update', handler);
            resolve();
          }
        };
        subscriptionService.on('stats_update', handler);
      });

      // Yield stats from the updated cache
      const stats = statsCache.getZFS();
      yield stats;
    }
  });

/**
 * Get list of active ZFS pools from the database.
 */
export const getActiveZFSPools = createServerFn()
  .handler(async (): Promise<string[]> => {
    const { subscriptionService } = await import('@/lib/database/subscription-service');
    const { statsCache } = await import('@/lib/cache/stats-cache');

    await subscriptionService.start();

    // Get pool names (entities without '/' are pools)
    const pools: string[] = [];
    for (const entityPath of statsCache.getAllZFS().keys()) {
      if (!entityPath.includes('/')) {
        pools.push(entityPath);
      }
    }
    return pools;
  });

/**
 * Check if ZFS data in cache is stale (no updates for 30+ seconds)
 */
export const isZFSDataStale = createServerFn()
  .handler(async (): Promise<boolean> => {
    const { statsCache } = await import('@/lib/cache/stats-cache');
    return statsCache.isZFSStale();
  });

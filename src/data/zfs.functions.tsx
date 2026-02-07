import { createServerFn } from '@tanstack/react-start';

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

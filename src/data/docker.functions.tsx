import { createServerFn } from '@tanstack/react-start';

/**
 * Get list of active Docker containers from the database.
 */
export const getActiveDockerContainers = createServerFn()
  .handler(async (): Promise<string[]> => {
    const { subscriptionService } = await import('@/lib/database/subscription-service');
    const { statsCache } = await import('@/lib/cache/stats-cache');

    await subscriptionService.start();
    return Array.from(statsCache.getAllDocker().keys());
  });

/**
 * Check if Docker data in cache is stale (no updates for 30+ seconds)
 */
export const isDockerDataStale = createServerFn()
  .handler(async (): Promise<boolean> => {
    const { statsCache } = await import('@/lib/cache/stats-cache');
    return statsCache.isDockerStale();
  });

import { createServerFn } from '@tanstack/react-start';
import type { DockerStatsFromDB } from '@/lib/transformers/docker-transformer';

/**
 * Stream Docker stats from the database via PostgreSQL LISTEN/NOTIFY.
 * Uses the shared stats cache updated by the subscription service.
 */
export const streamDockerStatsFromDB = createServerFn()
  .handler(async function* (): AsyncGenerator<DockerStatsFromDB[]> {
    // Dynamic imports to avoid bundling server-only code into client
    // Also initializes server-side shutdown handlers
    await import('@/lib/server-init');
    const { subscriptionService } = await import('@/lib/database/subscription-service');
    const { statsCache } = await import('@/lib/cache/stats-cache');

    // Ensure subscription service is running
    await subscriptionService.start();

    // Yield initial state from cache
    const initialStats = statsCache.getDocker();
    if (initialStats.length > 0) {
      yield initialStats;
    }

    // Wait for updates and yield stats
    while (true) {
      await new Promise<void>(resolve => {
        const handler = (source: string) => {
          if (source === 'docker') {
            subscriptionService.removeListener('stats_update', handler);
            resolve();
          }
        };
        subscriptionService.on('stats_update', handler);
      });

      // Yield all stats from the updated cache
      const stats = statsCache.getDocker();
      yield stats;
    }
  });

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

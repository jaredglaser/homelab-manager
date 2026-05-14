import { createServerFn } from '@tanstack/react-start';
import type { ZFSStatsRow } from '@/types/zfs';
import { databaseMiddleware } from '@/middleware/database-middleware';
import { authMiddleware } from '@/middleware/auth-middleware';
import { getHistoricalZFSStatsSchema } from '@/data/zfs/schemas';

/**
 * Get historical ZFS stats (wide rows) for preloading.
 */
export const getHistoricalZFSStats = createServerFn()
  .middleware([authMiddleware, databaseMiddleware])
  .inputValidator(getHistoricalZFSStatsSchema)
  .handler(async ({ context, data }): Promise<ZFSStatsRow[]> => {
    try {
      const { StatsRepository } = await import(
        '@/lib/database/repositories/stats-repository'
      );
      const repo = new StatsRepository(context.pool);

      return await repo.getZFSStatsHistory(data.seconds);
    } catch (err) {
      console.error('[getHistoricalZFSStats] Failed to fetch historical data:', err);
      return [];
    }
  });

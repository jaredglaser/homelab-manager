import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { ZFSStatsRow } from '@/types/zfs';

const getHistoricalZFSStatsSchema = z.object({
  /** Number of seconds of historical data to fetch. Default: 60 */
  seconds: z.number().optional().default(60),
});

/**
 * Get historical ZFS stats (wide rows) for preloading.
 */
export const getHistoricalZFSStats = createServerFn()
  .inputValidator(getHistoricalZFSStatsSchema)
  .handler(async ({ data }): Promise<ZFSStatsRow[]> => {
    try {
      const { databaseConnectionManager } = await import(
        '@/lib/clients/database-client'
      );
      const { loadDatabaseConfig } = await import('@/lib/config/database-config');
      const { StatsRepository } = await import(
        '@/lib/database/repositories/stats-repository'
      );

      const config = loadDatabaseConfig();
      const dbClient = await databaseConnectionManager.getClient(config);
      const repo = new StatsRepository(dbClient.getPool());

      return await repo.getZFSStatsHistory(data.seconds);
    } catch (err) {
      console.error('[getHistoricalZFSStats] Failed to fetch historical data:', err);
      return [];
    }
  });

import { createServerFn } from '@tanstack/react-start';
import type { ProxmoxStatsRow } from '@/types/proxmox';
import { databaseMiddleware } from '@/middleware/database-middleware';
import { authMiddleware } from '@/middleware/auth-middleware';
import { roleMiddleware } from '@/lib/auth/role-middleware';
import { getHistoricalProxmoxStatsSchema } from '@/data/proxmox/schemas';

/**
 * Fetch historical Proxmox stats rows from the database.
 * Used by useTimeSeriesStream to preload data before live streaming begins.
 */
export const getHistoricalProxmoxStats = createServerFn()
  .middleware([authMiddleware, roleMiddleware('admin', 'operator', 'viewer'), databaseMiddleware])
  .validator(getHistoricalProxmoxStatsSchema)
  .handler(async ({ context, data }): Promise<ProxmoxStatsRow[]> => {
    try {
      const { StatsRepository } = await import(
        '@/lib/database/repositories/stats-repository'
      );
      const repo = new StatsRepository(context.pool);

      return await repo.getProxmoxStatsHistory(data.seconds);
    } catch (err) {
      console.error('[getHistoricalProxmoxStats] Failed to fetch historical data:', err);
      return [];
    }
  });

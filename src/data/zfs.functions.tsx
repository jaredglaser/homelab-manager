import { createServerFn } from '@tanstack/react-start';

export interface HistoricalDataPoint {
  timestamp: number;
  readBytesPerSec: number;
  writeBytesPerSec: number;
}

export interface HistoricalPoolData {
  poolName: string;
  dataPoints: HistoricalDataPoint[];
}

/**
 * Get historical ZFS chart data for the last 60 seconds.
 * Used to pre-populate charts on initial load.
 */
export const getHistoricalZFSChartData = createServerFn().handler(
  async (): Promise<HistoricalPoolData[]> => {
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

      const now = new Date();
      const sixtySecondsAgo = new Date(now.getTime() - 60000);

      // Get time series data for read/write bytes per second, filtered to pool-level entities
      const rows = await repo.getTimeSeriesStats({
        sourceName: 'zfs',
        startTime: sixtySecondsAgo,
        endTime: now,
        typeNames: ['read_bytes_per_sec', 'write_bytes_per_sec'],
        entityFilter: (entity) => !entity.includes('/'), // Pool-level only (no vdevs/disks)
      });

      // Group by pool and timestamp
      const poolMap = new Map<
        string,
        Map<number, { read: number; write: number }>
      >();

      for (const row of rows) {
        const ts = row.timestamp.getTime();

        if (!poolMap.has(row.entity)) {
          poolMap.set(row.entity, new Map());
        }
        const timestampMap = poolMap.get(row.entity)!;

        if (!timestampMap.has(ts)) {
          timestampMap.set(ts, { read: 0, write: 0 });
        }
        const point = timestampMap.get(ts)!;

        if (row.type === 'read_bytes_per_sec') {
          point.read = row.value;
        } else if (row.type === 'write_bytes_per_sec') {
          point.write = row.value;
        }
      }

      // Convert to output format
      const result: HistoricalPoolData[] = [];

      for (const [poolName, timestampMap] of poolMap) {
        const dataPoints: HistoricalDataPoint[] = [];

        // Sort by timestamp ascending
        const sortedTimestamps = [...timestampMap.keys()].sort((a, b) => a - b);

        for (const ts of sortedTimestamps) {
          const point = timestampMap.get(ts)!;
          dataPoints.push({
            timestamp: ts,
            readBytesPerSec: point.read,
            writeBytesPerSec: point.write,
          });
        }

        result.push({ poolName, dataPoints });
      }

      return result;
    } catch (err) {
      console.error('[getHistoricalZFSChartData] Failed to fetch historical data:', err);
      return [];
    }
  }
);

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

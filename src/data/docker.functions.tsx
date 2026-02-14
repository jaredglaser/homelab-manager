import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';

export interface ContainerChartDataPoint {
  timestamp: number;
  cpuPercent: number;
  memoryPercent: number;
  blockIoReadBytesPerSec: number;
  blockIoWriteBytesPerSec: number;
  networkRxBytesPerSec: number;
  networkTxBytesPerSec: number;
}

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

const getHistoricalDockerChartDataSchema = z.object({
  containerId: z.string(),
  /** Number of seconds of historical data to fetch. Default: 60 */
  seconds: z.number().optional().default(60),
});

/**
 * Get historical Docker chart data for a specific container.
 * Used to pre-populate charts when expanding a container row.
 */
export const getHistoricalDockerChartData = createServerFn()
  .inputValidator(getHistoricalDockerChartDataSchema)
  .handler(async ({ data }): Promise<ContainerChartDataPoint[]> => {
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
      const startTime = new Date(now.getTime() - data.seconds * 1000);

      // Get time series data for all 6 metric types for this container
      const rows = await repo.getTimeSeriesStats({
        sourceName: 'docker',
        startTime,
        endTime: now,
        typeNames: [
          'cpu_percent',
          'memory_percent',
          'block_io_read_bytes_per_sec',
          'block_io_write_bytes_per_sec',
          'network_rx_bytes_per_sec',
          'network_tx_bytes_per_sec',
        ],
        entityFilter: (entity) => entity === data.containerId,
      });

      // Group by timestamp
      const timestampMap = new Map<
        number,
        {
          cpuPercent: number;
          memoryPercent: number;
          blockIoReadBytesPerSec: number;
          blockIoWriteBytesPerSec: number;
          networkRxBytesPerSec: number;
          networkTxBytesPerSec: number;
        }
      >();

      for (const row of rows) {
        const ts = row.timestamp.getTime();

        if (!timestampMap.has(ts)) {
          timestampMap.set(ts, {
            cpuPercent: 0,
            memoryPercent: 0,
            blockIoReadBytesPerSec: 0,
            blockIoWriteBytesPerSec: 0,
            networkRxBytesPerSec: 0,
            networkTxBytesPerSec: 0,
          });
        }
        const point = timestampMap.get(ts)!;

        switch (row.type) {
          case 'cpu_percent':
            point.cpuPercent = row.value;
            break;
          case 'memory_percent':
            point.memoryPercent = row.value;
            break;
          case 'block_io_read_bytes_per_sec':
            point.blockIoReadBytesPerSec = row.value;
            break;
          case 'block_io_write_bytes_per_sec':
            point.blockIoWriteBytesPerSec = row.value;
            break;
          case 'network_rx_bytes_per_sec':
            point.networkRxBytesPerSec = row.value;
            break;
          case 'network_tx_bytes_per_sec':
            point.networkTxBytesPerSec = row.value;
            break;
        }
      }

      // Convert to output format, sorted by timestamp ascending
      const sortedTimestamps = [...timestampMap.keys()].sort((a, b) => a - b);

      return sortedTimestamps.map((ts) => ({
        timestamp: ts,
        ...timestampMap.get(ts)!,
      }));
    } catch (err) {
      console.error('[getHistoricalDockerChartData] Failed to fetch historical data:', err);
      return [];
    }
  });

const updateContainerIconSchema = z.object({
  entityId: z.string().min(1),
  iconSlug: z.string().min(1),
});

/**
 * Update the icon for a container.
 * Stores the icon slug in entity metadata for persistence.
 */
export const updateContainerIcon = createServerFn()
  .inputValidator(updateContainerIconSchema)
  .handler(async ({ data }): Promise<void> => {
    const { databaseConnectionManager } = await import('@/lib/clients/database-client');
    const { loadDatabaseConfig } = await import('@/lib/config/database-config');
    const { StatsRepository } = await import('@/lib/database/repositories/stats-repository');

    const config = loadDatabaseConfig();
    const dbClient = await databaseConnectionManager.getClient(config);
    const repo = new StatsRepository(dbClient.getPool());

    await repo.upsertEntityMetadata('docker', data.entityId, 'icon', data.iconSlug);
  });

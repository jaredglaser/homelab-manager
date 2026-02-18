import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { DockerStatsRow } from '@/types/docker';

const getHistoricalDockerStatsSchema = z.object({
  /** Number of seconds of historical data to fetch. Default: 60 */
  seconds: z.number().optional().default(60),
});

/**
 * Get historical Docker stats (wide rows) for preloading.
 */
export const getHistoricalDockerStats = createServerFn()
  .inputValidator(getHistoricalDockerStatsSchema)
  .handler(async ({ data }): Promise<DockerStatsRow[]> => {
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

      return await repo.getDockerStatsHistory(data.seconds);
    } catch (err) {
      console.error('[getHistoricalDockerStats] Failed to fetch historical data:', err);
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

import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { DockerStatsRow } from '@/types/docker';

const getHistoricalDockerStatsSchema = z.object({
  /** Number of seconds of historical data to fetch. Default: 60 */
  seconds: z.number().min(1).max(3600).optional().default(60),
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

/**
 * Get all persisted icon slugs for Docker containers.
 * Returns a plain object mapping entity ID → icon slug.
 */
export const getDockerEntityIcons = createServerFn()
  .handler(async (): Promise<Record<string, string>> => {
    try {
      const { databaseConnectionManager } = await import('@/lib/clients/database-client');
      const { loadDatabaseConfig } = await import('@/lib/config/database-config');
      const { StatsRepository } = await import('@/lib/database/repositories/stats-repository');

      const config = loadDatabaseConfig();
      const dbClient = await databaseConnectionManager.getClient(config);
      const repo = new StatsRepository(dbClient.getPool());

      const iconsMap = await repo.getSourceIcons('docker');
      return Object.fromEntries(iconsMap);
    } catch (err) {
      console.error('[getDockerEntityIcons] Failed to fetch entity icons:', err);
      return {};
    }
  });

const getContainerHistorySchema = z.object({
  containerId: z.string().min(1),
  host: z.string().optional(),
  fromMs: z.number(),
  toMs: z.number(),
  targetPoints: z.number().min(1).max(5000).optional(),
});

export const getContainerHistory = createServerFn()
  .inputValidator(getContainerHistorySchema)
  .handler(async ({ data }): Promise<DockerStatsRow[]> => {
    try {
      const { databaseConnectionManager } = await import('@/lib/clients/database-client');
      const { loadDatabaseConfig } = await import('@/lib/config/database-config');
      const { StatsRepository } = await import('@/lib/database/repositories/stats-repository');

      const config = loadDatabaseConfig();
      const dbClient = await databaseConnectionManager.getClient(config);
      const repo = new StatsRepository(dbClient.getPool());

      return await repo.getDockerStatsForContainer(
        data.containerId,
        data.host,
        new Date(data.fromMs),
        new Date(data.toMs),
        data.targetPoints,
      );
    } catch (err) {
      console.error('[getContainerHistory] Failed to fetch container history:', err);
      return [];
    }
  });

const getContainerInfoSchema = z.object({
  containerId: z.string().min(1),
  host: z.string().optional(),
});

export const getContainerInfo = createServerFn()
  .inputValidator(getContainerInfoSchema)
  .handler(async ({ data }): Promise<{
    containerName: string;
    image: string;
    host: string;
    icon: string | null;
  } | null> => {
    try {
      const { databaseConnectionManager } = await import('@/lib/clients/database-client');
      const { loadDatabaseConfig } = await import('@/lib/config/database-config');
      const { StatsRepository } = await import('@/lib/database/repositories/stats-repository');

      const config = loadDatabaseConfig();
      const dbClient = await databaseConnectionManager.getClient(config);
      const repo = new StatsRepository(dbClient.getPool());

      const info = await repo.getContainerInfo(data.containerId, data.host);
      if (!info) return null;

      const entityId = `${info.host}/${data.containerId}`;
      const icons = await repo.getSourceIcons('docker');
      const icon = icons.get(entityId) ?? null;

      return {
        containerName: info.container_name,
        image: info.image,
        host: info.host,
        icon,
      };
    } catch (err) {
      console.error('[getContainerInfo] Failed to fetch container info:', err);
      return null;
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

import { createServerFn } from '@tanstack/react-start';
import type { DockerStatsRow } from '@/types/docker';
import {
  getHistoricalDockerStatsSchema,
  getContainerHistorySchema,
  getContainerInfoSchema,
  updateContainerIconSchema,
} from '@/data/docker.schemas';

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
 * Get icon and service_key entity for each Docker container.
 * Returns a plain object mapping container entity (host/container_id) →
 * { iconSlug, serviceKeyEntity } for use in the live dashboard.
 * Icons are stored under the service_key entity so they survive container recreation.
 */
export const getDockerEntityIcons = createServerFn()
  .handler(async (): Promise<Record<string, { iconSlug: string | null; serviceKeyEntity: string }>> => {
    try {
      const { databaseConnectionManager } = await import('@/lib/clients/database-client');
      const { loadDatabaseConfig } = await import('@/lib/config/database-config');
      const { StatsRepository } = await import('@/lib/database/repositories/stats-repository');

      const config = loadDatabaseConfig();
      const dbClient = await databaseConnectionManager.getClient(config);
      const repo = new StatsRepository(dbClient.getPool());

      const metaMap = await repo.getDockerContainerMetadata('docker');
      return Object.fromEntries(metaMap);
    } catch (err) {
      console.error('[getDockerEntityIcons] Failed to fetch entity icons:', err);
      return {};
    }
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

      const fromMs = Math.min(data.fromMs, data.toMs);
      const toMs = Math.max(data.fromMs, data.toMs);

      // Fan out to all container IDs that share the same service_key on this host,
      // so history is seamlessly unified across container recreations.
      let containerIds: string[] = [data.containerId];
      if (data.host) {
        const linked = await repo.getLinkedContainerIds(
          'docker',
          `${data.host}/${data.containerId}`,
          data.host,
        );
        if (linked.length > 0) containerIds = linked;
      }

      return await repo.getDockerStatsForContainer(
        containerIds,
        data.host,
        new Date(fromMs),
        new Date(toMs),
        data.targetPoints,
      );
    } catch (err) {
      console.error('[getContainerHistory] Failed to fetch container history:', err);
      return [];
    }
  });

export const getContainerInfo = createServerFn()
  .inputValidator(getContainerInfoSchema)
  .handler(async ({ data }): Promise<{
    containerName: string;
    image: string;
    host: string;
    icon: string | null;
    serviceKey: string | null;
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

      const containerEntity = `${info.host}/${data.containerId}`;
      const serviceInfo = await repo.getContainerServiceInfo('docker', containerEntity);

      return {
        containerName: info.container_name ?? data.containerId.substring(0, 12),
        image: info.image ?? '',
        host: info.host,
        icon: serviceInfo?.icon ?? null,
        serviceKey: serviceInfo?.serviceKey ?? null,
      };
    } catch (err) {
      console.error('[getContainerInfo] Failed to fetch container info:', err);
      return null;
    }
  });

/**
 * Update the icon for a container service.
 * Stores the icon slug under the service_key entity so it persists across container recreations.
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

    await repo.upsertEntityMetadata('docker', data.serviceKeyEntity, 'icon', data.iconSlug);
  });

import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { DockerStatsRow } from '@/types/docker';
import type { ContainerVersionSummary, ContainerDetails, ContainerPort, ContainerVolume, GitHubRelease } from '@/types/container-versions';

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

const updateContainerIconSchema = z.object({
  /** Service-key entity path (host/service_key) - icon is stored here so it survives recreation. */
  serviceKeyEntity: z.string().min(1),
  iconSlug: z.string().min(1),
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

// ─── Container Version & Info Functions ───────────────────────────────────────

export const getContainerVersions = createServerFn()
  .handler(async (): Promise<ContainerVersionSummary[]> => {
    try {
      const { databaseConnectionManager } = await import('@/lib/clients/database-client');
      const { loadDatabaseConfig } = await import('@/lib/config/database-config');
      const { StatsRepository } = await import('@/lib/database/repositories/stats-repository');

      const config = loadDatabaseConfig();
      const dbClient = await databaseConnectionManager.getClient(config);
      const repo = new StatsRepository(dbClient.getPool());

      return await repo.getContainerVersionSummaries();
    } catch (err) {
      console.error('[getContainerVersions] Failed:', err);
      return [];
    }
  });

const getContainerDetailsSchema = z.object({
  containerId: z.string().min(1),
  host: z.string().min(1),
});

export const getContainerDetails = createServerFn()
  .inputValidator(getContainerDetailsSchema)
  .handler(async ({ data }): Promise<ContainerDetails | null> => {
    try {
      const { databaseConnectionManager } = await import('@/lib/clients/database-client');
      const { loadDatabaseConfig } = await import('@/lib/config/database-config');
      const { StatsRepository } = await import('@/lib/database/repositories/stats-repository');
      const { dockerConnectionManager } = await import('@/lib/clients/docker-client');
      const { loadDockerConfig } = await import('@/lib/config/docker-config');

      const dbConfig = loadDatabaseConfig();
      const dbClient = await databaseConnectionManager.getClient(dbConfig);
      const repo = new StatsRepository(dbClient.getPool());

      const dockerConfig = loadDockerConfig();
      const hostConfig = dockerConfig.hosts.find(h => h.host === data.host || h.name === data.host);
      if (!hostConfig) return null;

      const dockerClient = await dockerConnectionManager.getClient(hostConfig);
      const docker = dockerClient.getDocker();
      const container = docker.getContainer(data.containerId);
      const inspectData = await container.inspect();

      const image = inspectData.Config.Image || '';
      const ociVersion = inspectData.Config.Labels?.['org.opencontainers.image.version'] || null;

      // Get version info from DB
      const versions = await repo.getContainerVersionSummaries();
      const versionInfo = versions.find(v => v.image === image);

      // Get github repo info: manual override takes priority, then fall back to version-check-discovered repo
      const containerEntity = `${data.host}/${data.containerId}`;
      const manualOverride = await repo.getEntityMetadataValue('docker', containerEntity, 'github_repo_override');
      const githubRepo = manualOverride
        ?? (versionInfo?.github_repo ? `https://github.com/${versionInfo.github_repo}` : null);
      const githubRepoSource = manualOverride ? 'manual' : (versionInfo?.github_repo_source ?? null);

      // Parse ports
      const ports: ContainerPort[] = [];
      const portBindings = inspectData.HostConfig.PortBindings || {};
      for (const [containerPortProto, bindings] of Object.entries(portBindings)) {
        const [portStr, protocol] = containerPortProto.split('/');
        for (const binding of (bindings as any[]) || []) {
          ports.push({
            containerPort: parseInt(portStr, 10),
            hostPort: binding.HostPort ? parseInt(binding.HostPort, 10) : null,
            protocol: protocol || 'tcp',
            hostIp: binding.HostIp || '0.0.0.0',
          });
        }
      }

      // Parse volumes/mounts
      const volumes: ContainerVolume[] = (inspectData.Mounts || []).map((m: any) => ({
        source: m.Source || '',
        destination: m.Destination || '',
        mode: m.Mode || '',
        rw: m.RW ?? true,
      }));

      return {
        containerId: data.containerId,
        containerName: inspectData.Name?.replace(/^\//, '') || '',
        image,
        status: inspectData.State.Status || 'unknown',
        created: inspectData.Created || '',
        restartPolicy: inspectData.HostConfig.RestartPolicy?.Name || 'no',
        currentTag: versionInfo?.current_tag ?? null,
        currentVersion: ociVersion,
        latestTag: versionInfo?.latest_tag ?? null,
        updateAvailable: versionInfo?.update_available ?? false,
        githubRepo,
        githubRepoSource,
        ports,
        volumes,
      };
    } catch (err) {
      console.error('[getContainerDetails] Failed:', err);
      return null;
    }
  });

const getContainerChangelogSchema = z.object({
  image: z.string().min(1),
});

export const getContainerChangelog = createServerFn()
  .inputValidator(getContainerChangelogSchema)
  .handler(async ({ data }): Promise<GitHubRelease[]> => {
    try {
      const { databaseConnectionManager } = await import('@/lib/clients/database-client');
      const { loadDatabaseConfig } = await import('@/lib/config/database-config');
      const { StatsRepository } = await import('@/lib/database/repositories/stats-repository');

      const config = loadDatabaseConfig();
      const dbClient = await databaseConnectionManager.getClient(config);
      const repo = new StatsRepository(dbClient.getPool());

      return await repo.getContainerChangelog(data.image);
    } catch (err) {
      console.error('[getContainerChangelog] Failed:', err);
      return [];
    }
  });

const updateContainerGithubRepoSchema = z.object({
  serviceKeyEntity: z.string().min(1),
  githubRepoUrl: z.string().min(1),
});

export const updateContainerGithubRepo = createServerFn()
  .inputValidator(updateContainerGithubRepoSchema)
  .handler(async ({ data }): Promise<void> => {
    const { databaseConnectionManager } = await import('@/lib/clients/database-client');
    const { loadDatabaseConfig } = await import('@/lib/config/database-config');
    const { StatsRepository } = await import('@/lib/database/repositories/stats-repository');

    const config = loadDatabaseConfig();
    const dbClient = await databaseConnectionManager.getClient(config);
    const repo = new StatsRepository(dbClient.getPool());

    await repo.upsertEntityMetadata('docker', data.serviceKeyEntity, 'github_repo_override', data.githubRepoUrl);
  });

import type { DockerStatsRow } from '@/types/docker';
import type { ContainerVersionSummary, ContainerDetails, GitHubRelease } from '@/types/container-versions';
import { generateDockerHistory, generateContainerHistory } from '@/lib/mock/generators/docker';
import { DOCKER_ENTITIES } from '@/lib/mock/entities';
import { MOCK_CONTAINER_VERSIONS, MOCK_CONTAINER_CHANGELOGS } from '@/lib/mock/generators/versions';

const MAX_HISTORY_SECONDS = 3600;

/**
 * Mock: Get historical Docker stats for preloading.
 * Matches the real `getHistoricalDockerStats` signature.
 */
export const getHistoricalDockerStats = async (opts?: {
  data?: { seconds?: number };
}): Promise<DockerStatsRow[]> => {
  const seconds = Math.min(opts?.data?.seconds ?? 60, MAX_HISTORY_SECONDS);
  return generateDockerHistory(seconds);
};

/**
 * Mock: Get icon and service_key entity mapping for Docker containers.
 * Returns a static mapping built from entity definitions.
 */
export const getDockerEntityIcons = async (): Promise<
  Record<string, { iconSlug: string | null; serviceKeyEntity: string }>
> => {
  const result: Record<string, { iconSlug: string | null; serviceKeyEntity: string }> = {};
  for (const e of DOCKER_ENTITIES) {
    const containerEntity = `${e.host}/${e.containerId}`;
    result[containerEntity] = {
      iconSlug: e.iconSlug,
      serviceKeyEntity: `${e.host}/${e.serviceKey}`,
    };
  }
  return result;
};

/**
 * Mock: Get history for a specific container.
 */
export const getContainerHistory = async (opts: {
  data: {
    containerId: string;
    host?: string;
    fromMs: number;
    toMs: number;
    targetPoints?: number;
  };
}): Promise<DockerStatsRow[]> => {
  const { containerId, host, fromMs, toMs, targetPoints } = opts.data;
  return generateContainerHistory(containerId, host, fromMs, toMs, targetPoints);
};

/**
 * Mock: Get container info (name, image, host, icon, service key).
 */
export const getContainerInfo = async (opts: {
  data: {
    containerId: string;
    host?: string;
  };
}): Promise<{
  containerName: string;
  image: string;
  host: string;
  icon: string | null;
  serviceKey: string | null;
} | null> => {
  const { containerId, host } = opts.data;
  const entity = DOCKER_ENTITIES.find(
    (e) => e.containerId === containerId && (!host || e.host === host),
  );
  if (!entity) return null;

  return {
    containerName: entity.containerName,
    image: entity.image,
    host: entity.host,
    icon: entity.iconSlug,
    serviceKey: entity.serviceKey,
  };
};

/**
 * Mock: Update container icon - no-op in demo mode.
 */
export const updateContainerIcon = async (_opts: {
  data: {
    serviceKeyEntity: string;
    iconSlug: string;
  };
}): Promise<void> => {
  // No-op in demo mode
};

/**
 * Mock: Get container version summaries for update indicators.
 */
export const getContainerVersions = async (): Promise<ContainerVersionSummary[]> => {
  return MOCK_CONTAINER_VERSIONS;
};

/**
 * Mock: Get detailed container info (simulates Docker inspect).
 */
export const getContainerDetails = async (opts: {
  data: {
    containerId: string;
    host: string;
  };
}): Promise<ContainerDetails | null> => {
  const { containerId, host } = opts.data;
  const entity = DOCKER_ENTITIES.find(
    (e) => e.containerId === containerId && e.host === host,
  );
  if (!entity) return null;

  const version = MOCK_CONTAINER_VERSIONS.find(v => v.image === entity.image);

  return {
    containerId: entity.containerId,
    containerName: entity.containerName,
    image: entity.image,
    status: 'running',
    created: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    restartPolicy: 'unless-stopped',
    currentTag: version?.current_tag ?? null,
    latestTag: version?.latest_tag ?? null,
    updateAvailable: version?.update_available ?? false,
    githubRepo: null,
    githubRepoSource: null,
    ports: [
      { containerPort: 80, hostPort: 8080, protocol: 'tcp', hostIp: '0.0.0.0' },
    ],
    volumes: [
      { source: `/opt/${entity.containerName}/config`, destination: '/config', mode: '', rw: true },
      { source: `/opt/${entity.containerName}/data`, destination: '/data', mode: '', rw: true },
    ],
  };
};

/**
 * Mock: Get changelog for a container image.
 */
export const getContainerChangelog = async (opts: {
  data: { image: string };
}): Promise<GitHubRelease[]> => {
  return MOCK_CONTAINER_CHANGELOGS[opts.data.image] ?? [];
};

/**
 * Mock: Update GitHub repo override - no-op in demo mode.
 */
export const updateContainerGithubRepo = async (_opts: {
  data: {
    serviceKeyEntity: string;
    githubRepoUrl: string;
  };
}): Promise<void> => {
  // No-op in demo mode
};

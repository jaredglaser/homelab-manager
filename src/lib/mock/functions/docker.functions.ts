import type { DockerStatsRow } from '@/types/docker';
import { generateDockerHistory, generateContainerHistory } from '../generators/docker';
import { DOCKER_ENTITIES } from '../entities';

/**
 * Mock: Get historical Docker stats for preloading.
 * Matches the real `getHistoricalDockerStats` signature.
 */
export const getHistoricalDockerStats = async (opts?: {
  data?: { seconds?: number };
}): Promise<DockerStatsRow[]> => {
  const seconds = opts?.data?.seconds ?? 60;
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
  const { containerId, host, fromMs, toMs } = opts.data;
  return generateContainerHistory(containerId, host, fromMs, toMs);
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
 * Mock: Update container icon — no-op in demo mode.
 */
export const updateContainerIcon = async (_opts: {
  data: {
    serviceKeyEntity: string;
    iconSlug: string;
  };
}): Promise<void> => {
  // No-op in demo mode
};

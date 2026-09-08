import type { DockerStatsRow } from '@/types/docker';
import { generateDockerHistory, generateContainerHistory } from '@/lib/mock/generators/docker';
import { DOCKER_ENTITIES } from '@/lib/mock/entities';

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

export const clearContainerIcon = async (_opts: {
  data: {
    serviceKeyEntity: string;
  };
}): Promise<void> => {
  // No-op in demo mode
};

/**
 * Mock: Control container lifecycle (start/stop/restart) - no-op in demo mode.
 */
export const controlContainer = async (_opts: {
  data: {
    host: string;
    containerId: string;
    action: 'start' | 'stop' | 'restart';
  };
}): Promise<void> => {
  // No-op in demo mode
};

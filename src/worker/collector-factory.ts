import type { DatabaseClient } from '@/lib/clients/database-client';
import { loadDockerConfig } from '@/lib/config/docker-config';
import { isProxmoxConfigured, loadProxmoxConfig } from '@/lib/config/proxmox-config';
import { loadZFSConfig } from '@/lib/config/zfs-config';
import type { WorkerConfig } from '@/lib/config/worker-config';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';
import type { BaseCollector } from './collectors/base-collector';
import { AgentStatsCollector } from './collectors/agent-stats-collector';
import { DockerCollector } from './collectors/docker-collector';
import { ProxmoxCollector } from './collectors/proxmox-collector';
import { ZFSCollector } from './collectors/zfs-collector';

export interface CollectorFactoryResult {
  collectors: BaseCollector[];
  runners: Promise<void>[];
}

/**
 * Create and register enabled collectors based on the provided worker configuration.
 *
 * @param proxmoxPollIntervalMs - Optional poll interval in milliseconds for the Proxmox collector; when omitted a default of 10000 ms is used
 * @returns An object with `collectors` - the created collector instances, and `runners` - an array of each collector's run promise
 */
export function createCollectors(
  db: DatabaseClient,
  workerConfig: WorkerConfig,
  shutdownController: AbortController,
  stack: AsyncDisposableStack,
  proxmoxPollIntervalMs?: number,
): CollectorFactoryResult {
  const collectors: BaseCollector[] = [];
  const runners: Promise<void>[] = [];

  if (workerConfig.docker.enabled) {
    const dockerConfig = loadDockerConfig();

    if (dockerConfig.hosts.length === 0) {
      console.info('[Worker] Docker enabled but no hosts configured');
    } else {
      console.info(`[Worker] Starting ${dockerConfig.hosts.length} Docker collector(s)`);

      for (const hostConfig of dockerConfig.hosts) {
        console.info(`[Worker] Starting Docker collector for ${hostConfig.name}`);
        const collector = stack.use(
          new DockerCollector(db, workerConfig, hostConfig, shutdownController)
        );
        collectors.push(collector);
        runners.push(collector.run());
      }
    }
  } else {
    console.info('[Worker] Docker collector disabled');
  }

  if (workerConfig.zfs.enabled) {
    const zfsConfig = loadZFSConfig();

    if (zfsConfig.hosts.length === 0) {
      console.info('[Worker] ZFS enabled but no hosts configured');
    } else {
      console.info(`[Worker] Starting ${zfsConfig.hosts.length} ZFS collector(s)`);

      for (const hostConfig of zfsConfig.hosts) {
        console.info(`[Worker] Starting ZFS collector for ${hostConfig.name}`);
        const collector = stack.use(
          new ZFSCollector(db, workerConfig, hostConfig, shutdownController)
        );
        collectors.push(collector);
        runners.push(collector.run());
      }
    }
  } else {
    console.info('[Worker] ZFS collector disabled');
  }

  if (workerConfig.proxmox.enabled) {
    if (!isProxmoxConfigured()) {
      console.info('[Worker] Proxmox enabled but not configured');
    } else {
      const proxmoxConfig = loadProxmoxConfig();
      console.info(`[Worker] Starting Proxmox collector for ${proxmoxConfig.host}`);
      const collector = stack.use(
        new ProxmoxCollector(db, workerConfig, proxmoxConfig, proxmoxPollIntervalMs ?? 10_000, shutdownController)
      );
      collectors.push(collector);
      runners.push(collector.run());
    }
  } else {
    console.info('[Worker] Proxmox collector disabled');
  }

  return { collectors, runners };
}

/**
 * Create AgentStatsCollectors for managed hosts when the management feature flag is enabled.
 * Uses dependency injection for the feature flag check, host lookup, and token retrieval
 * to enable testing without database, env var, or OpenBao dependencies.
 *
 * Hosts whose token cannot be found in OpenBao are skipped.
 */
export async function createCollectorsForManagedHosts(
  db: DatabaseClient,
  workerConfig: WorkerConfig,
  shutdownController: AbortController,
  stack: AsyncDisposableStack,
  isManagementEnabled: () => boolean,
  findAllHosts: () => Promise<ManagedHost[]>,
  getToken: (hostname: string) => Promise<string | null>,
): Promise<CollectorFactoryResult> {
  const collectors: BaseCollector[] = [];
  const runners: Promise<void>[] = [];

  if (!isManagementEnabled()) {
    return { collectors, runners };
  }

  const hosts = await findAllHosts();
  if (hosts.length === 0) {
    console.info('[Worker] Management feature enabled but no managed hosts found');
    return { collectors, runners };
  }

  console.info(`[Worker] Starting ${hosts.length} AgentStatsCollector(s) for managed hosts`);

  for (const host of hosts) {
    let token: string | null;
    try {
      token = await getToken(host.name);
    } catch (err) {
      console.error(`[Worker] Failed to retrieve token for managed host ${host.name}:`, err instanceof Error ? err.message : err);
      continue;
    }
    if (!token) {
      console.info(`[Worker] Skipping managed host ${host.name}: no token found in OpenBao`);
      continue;
    }

    console.info(`[Worker] Starting AgentStatsCollector for ${host.name} (${host.agent_url})`);
    const collector = stack.use(
      new AgentStatsCollector(db, workerConfig, host, token, shutdownController)
    );
    collectors.push(collector);
    runners.push(collector.run());
  }

  return { collectors, runners };
}

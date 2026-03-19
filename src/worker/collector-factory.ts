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
      console.log('[Worker] Docker enabled but no hosts configured');
    } else {
      console.log(`[Worker] Starting ${dockerConfig.hosts.length} Docker collector(s)`);

      for (const hostConfig of dockerConfig.hosts) {
        console.log(`[Worker] Starting Docker collector for ${hostConfig.name}`);
        const collector = stack.use(
          new DockerCollector(db, workerConfig, hostConfig, shutdownController)
        );
        collectors.push(collector);
        runners.push(collector.run());
      }
    }
  } else {
    console.log('[Worker] Docker collector disabled');
  }

  if (workerConfig.zfs.enabled) {
    const zfsConfig = loadZFSConfig();

    if (zfsConfig.hosts.length === 0) {
      console.log('[Worker] ZFS enabled but no hosts configured');
    } else {
      console.log(`[Worker] Starting ${zfsConfig.hosts.length} ZFS collector(s)`);

      for (const hostConfig of zfsConfig.hosts) {
        console.log(`[Worker] Starting ZFS collector for ${hostConfig.name}`);
        const collector = stack.use(
          new ZFSCollector(db, workerConfig, hostConfig, shutdownController)
        );
        collectors.push(collector);
        runners.push(collector.run());
      }
    }
  } else {
    console.log('[Worker] ZFS collector disabled');
  }

  if (workerConfig.proxmox.enabled) {
    if (!isProxmoxConfigured()) {
      console.log('[Worker] Proxmox enabled but not configured');
    } else {
      const proxmoxConfig = loadProxmoxConfig();
      console.log(`[Worker] Starting Proxmox collector for ${proxmoxConfig.host}`);
      const collector = stack.use(
        new ProxmoxCollector(db, workerConfig, proxmoxConfig, proxmoxPollIntervalMs ?? 10_000, shutdownController)
      );
      collectors.push(collector);
      runners.push(collector.run());
    }
  } else {
    console.log('[Worker] Proxmox collector disabled');
  }

  return { collectors, runners };
}

/**
 * Create AgentStatsCollectors for managed hosts when the management feature flag is enabled.
 * Uses dependency injection for the feature flag check and host lookup to enable testing
 * without database or env var dependencies.
 *
 * Managed hosts with no `agent_token` are skipped (token not yet stored — host was
 * provisioned before the migration that added the agent_token column).
 */
export async function createCollectorsForManagedHosts(
  db: DatabaseClient,
  workerConfig: WorkerConfig,
  shutdownController: AbortController,
  stack: AsyncDisposableStack,
  isManagementEnabled: () => boolean,
  findAllHosts: () => Promise<ManagedHost[]>,
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
    if (!host.agent_token) {
      console.info(`[Worker] Skipping managed host ${host.name}: no agent_token (provisioned before migration)`);
      continue;
    }

    console.info(`[Worker] Starting AgentStatsCollector for ${host.name} (${host.agent_url})`);
    const collector = stack.use(
      new AgentStatsCollector(db, workerConfig, host, shutdownController)
    );
    collectors.push(collector);
    runners.push(collector.run());
  }

  return { collectors, runners };
}

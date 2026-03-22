import type { DatabaseClient } from '@/lib/clients/database-client';
import { loadDockerConfig } from '@/lib/config/docker-config';
import { isProxmoxConfigured, loadProxmoxConfig } from '@/lib/config/proxmox-config';
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
 * Create agent-based collectors for managed hosts when the management feature flag is enabled.
 * Uses dependency injection for the feature flag check and host lookup to enable testing
 * without database or env var dependencies.
 *
 * Creates both AgentStatsCollectors (Docker) and ZFSCollectors for each managed host.
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

  if (!isManagementEnabled() || (!workerConfig.docker.enabled && !workerConfig.zfs.enabled)) {
    return { collectors, runners };
  }

  const hosts = await findAllHosts();
  if (hosts.length === 0) {
    console.info('[Worker] Management feature enabled but no managed hosts found');
    return { collectors, runners };
  }

  for (const host of hosts) {
    if (!host.agent_token) {
      console.info(`[Worker] Skipping managed host ${host.name}: no agent_token (provisioned before migration)`);
      continue;
    }

    if (workerConfig.docker.enabled) {
      console.info(`[Worker] Starting AgentStatsCollector for ${host.name} (${host.agent_url})`);
      const dockerCollector = stack.use(
        new AgentStatsCollector(db, workerConfig, host, shutdownController)
      );
      collectors.push(dockerCollector);
      runners.push(dockerCollector.run());
    }

    if (workerConfig.zfs.enabled) {
      console.info(`[Worker] Starting ZFSCollector for ${host.name} (${host.agent_url})`);
      const zfsCollector = stack.use(
        new ZFSCollector(db, workerConfig, host, shutdownController)
      );
      collectors.push(zfsCollector);
      runners.push(zfsCollector.run());
    }
  }

  return { collectors, runners };
}

import type { DatabaseClient } from '@/lib/clients/database-client';
import { isProxmoxConfigured, loadProxmoxConfig } from '@/lib/config/proxmox-config';
import type { WorkerConfig } from '@/lib/config/worker-config';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';
import type { BaseCollector } from './collectors/base-collector';
import { AgentStatsCollector } from './collectors/agent-stats-collector';
import { ContainerInventoryCollector } from './collectors/container-inventory-collector';
import { ProxmoxCollector } from './collectors/proxmox-collector';
import { DockerContainerEventRepository } from '@/lib/database/repositories/docker-container-event-repository';
import { ZFSCollector } from './collectors/zfs-collector';

export interface CollectorFactoryResult {
  collectors: BaseCollector[];
  runners: Promise<void>[];
}

/**
 * Rewrite localhost agent URLs so the worker container can reach agents
 * on the same Docker network. Uses WORKER_LOCALHOST_AGENT env var as the
 * Docker-internal hostname (e.g. "hlm-agent"). Remote agent URLs
 * (e.g. 192.168.1.50:9090) pass through unchanged.
 */
export function resolveAgentUrl(url: string): string {
  const dockerHost = process.env.WORKER_LOCALHOST_AGENT;
  if (!dockerHost) return url;
  return url.replace(/:\/\/(\[?::1\]?|localhost|127\.0\.0\.1):/, `://${dockerHost}:`);
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
 * Hosts whose keypair signer cannot be resolved are skipped.
 *
 * @param getSigner - Callback that returns a JWT signer for a host, or null if no keypair exists
 */
export async function createCollectorsForManagedHosts(
  db: DatabaseClient,
  workerConfig: WorkerConfig,
  shutdownController: AbortController,
  stack: AsyncDisposableStack,
  findAllHosts: () => Promise<ManagedHost[]>,
  getSigner: (hostname: string) => Promise<(() => Promise<string>) | null>,
): Promise<CollectorFactoryResult> {
  const collectors: BaseCollector[] = [];
  const runners: Promise<void>[] = [];

  if (!workerConfig.docker.enabled && !workerConfig.zfs.enabled) {
    return { collectors, runners };
  }

  const hosts = await findAllHosts();
  if (hosts.length === 0) {
    console.info('[Worker] No managed hosts found');
    return { collectors, runners };
  }

  for (const host of hosts) {
    let signer: (() => Promise<string>) | null;
    try {
      signer = await getSigner(host.name);
    } catch (err) {
      console.error(`[Worker] Failed to retrieve token for managed host ${host.name}:`, err instanceof Error ? err.message : err);
      continue;
    }
    if (!signer) {
      console.info(`[Worker] Skipping managed host ${host.name}: no agent token in secret store`);
      continue;
    }

    const resolvedHost = { ...host, agentUrl: resolveAgentUrl(host.agentUrl) };

    // Respect per-host capabilities declared in managed_hosts: skip collectors
    // for capabilities the host didn't opt into, even if the global worker
    // config enables them. Matches the capability check in
    // createContainerInventoryCollectors below.
    if (workerConfig.docker.enabled) {
      if (!host.capabilities?.docker) {
        console.info(`[Worker] Skipping AgentStatsCollector for ${host.name}: Docker capability not enabled`);
      } else {
        console.info(`[Worker] Starting AgentStatsCollector for ${host.name} (${resolvedHost.agentUrl})`);
        const dockerCollector = stack.use(
          new AgentStatsCollector(db, workerConfig, resolvedHost, signer, shutdownController)
        );
        collectors.push(dockerCollector);
        runners.push(dockerCollector.run());
      }
    }

    if (workerConfig.zfs.enabled) {
      if (!host.capabilities?.zfs) {
        console.info(`[Worker] Skipping ZFSCollector for ${host.name}: ZFS capability not enabled`);
      } else {
        console.info(`[Worker] Starting ZFSCollector for ${host.name} (${resolvedHost.agentUrl})`);
        const zfsCollector = stack.use(
          new ZFSCollector(db, workerConfig, resolvedHost, signer, shutdownController)
        );
        collectors.push(zfsCollector);
        runners.push(zfsCollector.run());
      }
    }
  }

  return { collectors, runners };
}

/**
 * Create ContainerInventoryCollectors for managed hosts with Docker capability enabled.
 * Each collector subscribes to the agent's /containers/events SSE endpoint and writes
 * state-change events to docker_container_events (hypertable, append-only).
 *
 * @param getSigner - Callback that returns a JWT signer for a host, or null if no keypair exists
 */
export async function createContainerInventoryCollectors(
  db: DatabaseClient,
  shutdownController: AbortController,
  stack: AsyncDisposableStack,
  findAllHosts: () => Promise<ManagedHost[]>,
  getSigner: (hostname: string) => Promise<(() => Promise<string>) | null>,
): Promise<{ runners: Promise<void>[] }> {
  const runners: Promise<void>[] = [];

  const hosts = await findAllHosts();
  const repo = new DockerContainerEventRepository(db.getPool());

  for (const host of hosts) {
    if (!host.capabilities?.docker) {
      console.info(`[Worker] Skipping ContainerInventoryCollector for ${host.name}: Docker capability not enabled`);
      continue;
    }
    let signer: (() => Promise<string>) | null;
    try {
      signer = await getSigner(host.name);
    } catch (err) {
      console.error(`[Worker] Failed to retrieve token for ContainerInventoryCollector ${host.name}:`, err instanceof Error ? err.message : err);
      continue;
    }
    if (!signer) {
      console.info(`[Worker] Skipping ContainerInventoryCollector for ${host.name}: no agent token in secret store`);
      continue;
    }

    const resolvedUrl = resolveAgentUrl(host.agentUrl);
    console.info(`[Worker] Starting ContainerInventoryCollector for ${host.name} (${resolvedUrl})`);
    const collector = stack.use(
      new ContainerInventoryCollector(
        { name: host.name, agentUrl: resolvedUrl },
        signer,
        repo,
        shutdownController,
      )
    );
    runners.push(collector.run());
  }

  return { runners };
}

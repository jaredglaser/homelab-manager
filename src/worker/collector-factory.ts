import type { DatabaseClient } from '@/lib/clients/database-client';
import { isProxmoxConfigured, loadProxmoxConfig } from '@/lib/config/proxmox-config';
import type { WorkerConfig } from '@/lib/config/worker-config';
import type { ManagedHostRow } from '@/lib/database/repositories/host-repository';
import type { BaseCollector } from './collectors/base-collector';
import { AgentStatsCollector } from './collectors/agent-stats-collector';
import { ProxmoxCollector } from './collectors/proxmox-collector';
import { StackStatusCollector } from './collectors/stack-status-collector';
import { StackStatusRepository } from '@/lib/database/repositories/stack-status-repository';
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
 * Hosts whose token cannot be resolved from OpenBao are skipped.
 *
 * @param getToken - Callback to look up a host's agent token from OpenBao (or other secret store)
 */
export async function createCollectorsForManagedHosts(
  db: DatabaseClient,
  workerConfig: WorkerConfig,
  shutdownController: AbortController,
  stack: AsyncDisposableStack,
  findAllHosts: () => Promise<ManagedHostRow[]>,
  getToken: (hostname: string) => Promise<string | null>,
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
    let token: string | null;
    try {
      token = await getToken(host.name);
    } catch (err) {
      console.error(`[Worker] Failed to retrieve token for managed host ${host.name}:`, err instanceof Error ? err.message : err);
      continue;
    }
    if (!token) {
      console.info(`[Worker] Skipping managed host ${host.name}: no agent token in secret store`);
      continue;
    }

    const resolvedHost = { ...host, agent_url: resolveAgentUrl(host.agent_url) };

    if (workerConfig.docker.enabled) {
      console.info(`[Worker] Starting AgentStatsCollector for ${host.name} (${resolvedHost.agent_url})`);
      const dockerCollector = stack.use(
        new AgentStatsCollector(db, workerConfig, resolvedHost, token, shutdownController)
      );
      collectors.push(dockerCollector);
      runners.push(dockerCollector.run());
    }

    if (workerConfig.zfs.enabled) {
      console.info(`[Worker] Starting ZFSCollector for ${host.name} (${resolvedHost.agent_url})`);
      const zfsCollector = stack.use(
        new ZFSCollector(db, workerConfig, resolvedHost, token, shutdownController)
      );
      collectors.push(zfsCollector);
      runners.push(zfsCollector.run());
    }
  }

  return { collectors, runners };
}

/**
 * Create StackStatusCollectors for managed hosts.
 * Each collector connects to the agent's /stacks/events SSE endpoint and persists
 * container status to the database.
 *
 * @param getToken - Callback to look up a host's agent token from OpenBao (or other secret store)
 */
export async function createStackStatusCollectors(
  db: DatabaseClient,
  shutdownController: AbortController,
  stack: AsyncDisposableStack,
  findAllHosts: () => Promise<ManagedHostRow[]>,
  getToken: (hostname: string) => Promise<string | null>,
): Promise<{ runners: Promise<void>[] }> {
  const runners: Promise<void>[] = [];

  const hosts = await findAllHosts();
  const repo = new StackStatusRepository(db.getPool());

  for (const host of hosts) {
    if (!host.capabilities?.docker) {
      console.info(`[Worker] Skipping StackStatusCollector for ${host.name}: Docker capability not enabled`);
      continue;
    }
    let token: string | null;
    try {
      token = await getToken(host.name);
    } catch (err) {
      console.error(`[Worker] Failed to retrieve token for StackStatusCollector ${host.name}:`, err instanceof Error ? err.message : err);
      continue;
    }
    if (!token) {
      console.info(`[Worker] Skipping StackStatusCollector for ${host.name}: no agent token in secret store`);
      continue;
    }

    const resolvedUrl = resolveAgentUrl(host.agent_url);
    console.info(`[Worker] Starting StackStatusCollector for ${host.name} (${resolvedUrl})`);
    const collector = stack.use(
      new StackStatusCollector(
        { name: host.name, agentUrl: resolvedUrl },
        token,
        repo,
        shutdownController,
      )
    );
    runners.push(collector.run());
  }

  return { runners };
}

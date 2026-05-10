import type { DatabaseClient } from '@/lib/clients/database-client';
import { isProxmoxConfigured, loadProxmoxConfig } from '@/lib/config/proxmox-config';
import type { WorkerConfig } from '@/lib/config/worker-config';
import type { BaseCollector } from './collectors/base-collector';
import { ProxmoxCollector } from './collectors/proxmox-collector';

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

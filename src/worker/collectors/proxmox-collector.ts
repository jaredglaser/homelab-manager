import type { DatabaseClient } from '@/lib/clients/database-client';
import type { ProxmoxConfig } from '@/lib/config/proxmox-config';
import type { WorkerConfig } from '@/lib/config/worker-config';
import { abortableSleep } from '@/lib/utils/abortable-sleep';
import { overviewToRows } from '@/lib/utils/proxmox-overview-converter';
import { BaseCollector } from './base-collector';

const DEFAULT_POLL_INTERVAL_MS = 10_000;

/**
 * Background collector for Proxmox cluster stats.
 *
 * Polls the Proxmox REST API at a configurable interval, converts the
 * cluster overview to flat rows, and inserts them into the proxmox_stats
 * hypertable. The poll interval can be changed at runtime via the
 * `pollInterval` setter (driven by SettingsListener).
 */
export class ProxmoxCollector extends BaseCollector {
  readonly name: string;
  private _pollIntervalMs: number;
  private _sleepAbortController: AbortController | null = null;
  private readonly proxmoxConfig: ProxmoxConfig;

  constructor(
    db: DatabaseClient,
    config: WorkerConfig,
    proxmoxConfig: ProxmoxConfig,
    initialPollIntervalMs: number,
    abortController?: AbortController,
  ) {
    super(db, config, abortController);
    this.proxmoxConfig = proxmoxConfig;
    this._pollIntervalMs = initialPollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
    this.name = `ProxmoxCollector[${proxmoxConfig.host}]`;
  }

  set pollInterval(ms: number) {
    this._pollIntervalMs = Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_POLL_INTERVAL_MS;
    this._sleepAbortController?.abort();
  }

  protected async collect(): Promise<void> {
    const { proxmoxConnectionManager } = await import('@/lib/clients/proxmox-client');
    const client = proxmoxConnectionManager.getClient(this.proxmoxConfig);

    this.resetBackoff();

    while (!this.signal.aborted) {
      const t0 = performance.now();

      const overview = await client.getClusterOverview();
      const rows = overviewToRows(overview, this.proxmoxConfig.host);

      this.dbDebugLog(
        `[${this.name}] Inserting ${rows.length} rows ` +
        `(${overview.nodes.length} nodes, ${overview.vms.length} VMs, ` +
        `${overview.containers.length} CTs, ${overview.storages.length} storages)`
      );

      await this.repository.insertProxmoxStats(rows);

      const elapsed = performance.now() - t0;
      const sleepMs = Math.max(0, this._pollIntervalMs - elapsed);

      this._sleepAbortController = new AbortController();
      try {
        await abortableSleep(sleepMs, AbortSignal.any([this.signal, this._sleepAbortController.signal]));
      } catch {
        if (this.signal.aborted) return;
        // Sleep interrupted by pollInterval change — continue immediately
      } finally {
        this._sleepAbortController = null;
      }
    }
  }
}

import type { DatabaseClient } from '@/lib/clients/database-client';
import { proxmoxConnectionManager } from '@/lib/clients/proxmox-client';
import type { ProxmoxConfig } from '@/lib/config/proxmox-config';
import type { WorkerConfig } from '@/lib/config/worker-config';
import { abortableSleep } from '@/lib/utils/abortable-sleep';
import { snapshotToRows } from '@/lib/utils/proxmox-overview-converter';
import { BaseCollector } from './base-collector';

const DEFAULT_POLL_INTERVAL_MS = 10_000;

/** Resolves a ProxmoxClient for a host config; narrowed so tests can inject a fake without spying on the singleton. */
type ProxmoxClientProvider = Pick<typeof proxmoxConnectionManager, 'getClient'>;

/** Polls the Proxmox REST API and inserts cluster snapshot rows into proxmox_stats; pollInterval is settable at runtime. */
export class ProxmoxCollector extends BaseCollector {
  readonly name: string;
  private _pollIntervalMs: number;
  private _sleepAbortController: AbortController | null = null;
  private readonly proxmoxConfig: ProxmoxConfig;
  private readonly clientProvider: ProxmoxClientProvider;

  constructor(
    db: DatabaseClient,
    config: WorkerConfig,
    proxmoxConfig: ProxmoxConfig,
    initialPollIntervalMs: number,
    abortController?: AbortController,
    clientProvider: ProxmoxClientProvider = proxmoxConnectionManager,
  ) {
    super(db, config, abortController);
    this.proxmoxConfig = proxmoxConfig;
    this._pollIntervalMs = initialPollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
    this.name = `ProxmoxCollector[${proxmoxConfig.host}]`;
    this.clientProvider = clientProvider;
  }

  set pollInterval(ms: number) {
    this._pollIntervalMs = Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_POLL_INTERVAL_MS;
    this._sleepAbortController?.abort();
  }

  protected async collect(): Promise<void> {
    const client = this.clientProvider.getClient(this.proxmoxConfig);

    this.resetBackoff();

    while (!this.signal.aborted) {
      const t0 = performance.now();

      const snapshot = await client.getClusterSnapshot();
      const rows = snapshotToRows(snapshot, this.proxmoxConfig.host);

      this.dbDebugLog(
        `[${this.name}] Inserting ${rows.length} rows ` +
        `from ${snapshot.resources.length} cluster resources`
      );

      await this.repository.insertProxmoxStats(rows);

      const elapsed = performance.now() - t0;
      const sleepMs = Math.max(0, this._pollIntervalMs - elapsed);

      this._sleepAbortController = new AbortController();
      try {
        await abortableSleep(sleepMs, AbortSignal.any([this.signal, this._sleepAbortController.signal]));
      } catch {
        if (this.signal.aborted) return;
        // Sleep interrupted by pollInterval change - continue immediately
      } finally {
        this._sleepAbortController = null;
      }
    }
  }
}

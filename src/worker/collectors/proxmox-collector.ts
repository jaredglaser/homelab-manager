import type { DatabaseClient } from '@/lib/clients/database-client';
import { proxmoxConnectionManager, ProxmoxRequestError } from '@/lib/clients/proxmox-client';
import type { ProxmoxConfig } from '@/lib/config/proxmox-config';
import type { WorkerConfig } from '@/lib/config/worker-config';
import { ProxmoxStateRepository } from '@/lib/database/repositories/proxmox-state-repository';
import type { ProxmoxCollectorStateKind } from '@/types/proxmox';
import { abortableSleep } from '@/lib/utils/abortable-sleep';
import { ProxmoxRateTracker, snapshotToRows } from '@/lib/utils/proxmox-overview-converter';
import { BaseCollector } from './base-collector';

const DEFAULT_POLL_INTERVAL_MS = 10_000;
// While collecting, only state changes are written, so this bounds how stale last_success_at can be after a worker restart.
const LAST_SUCCESS_REFRESH_MS = 60_000;

/** Resolves a ProxmoxClient for a host config; narrowed so tests can inject a fake without spying on the singleton. */
type ProxmoxClientProvider = Pick<typeof proxmoxConnectionManager, 'getClient'>;

export type ProxmoxStateStore = Pick<ProxmoxStateRepository, 'record'>;

/** The connection id the worker records state under, equal to the `host` its stats rows carry. */
export function proxmoxConnectionId(config: Pick<ProxmoxConfig, 'host'>): string {
  return config.host;
}

/** Polls the Proxmox REST API and inserts cluster snapshot rows into proxmox_stats; pollInterval is settable at runtime. */
export class ProxmoxCollector extends BaseCollector {
  readonly name: string;
  private _pollIntervalMs: number;
  private _sleepAbortController: AbortController | null = null;
  private readonly proxmoxConfig: ProxmoxConfig;
  private readonly clientProvider: ProxmoxClientProvider;
  private readonly rateTracker = new ProxmoxRateTracker();
  private readonly injectedStateStore: ProxmoxStateStore | undefined;
  private _stateStore: ProxmoxStateStore | undefined;
  private recorded: { state: ProxmoxCollectorStateKind; detail: string | null; at: number } | null = null;
  private lastSuccessAt: Date | null = null;

  constructor(
    db: DatabaseClient,
    config: WorkerConfig,
    proxmoxConfig: ProxmoxConfig,
    initialPollIntervalMs: number,
    abortController?: AbortController,
    clientProvider: ProxmoxClientProvider = proxmoxConnectionManager,
    stateStore?: ProxmoxStateStore,
  ) {
    super(db, config, abortController);
    this.proxmoxConfig = proxmoxConfig;
    this._pollIntervalMs = initialPollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
    this.name = `ProxmoxCollector[${proxmoxConfig.host}]`;
    this.clientProvider = clientProvider;
    this.injectedStateStore = stateStore;
  }

  set pollInterval(ms: number) {
    this._pollIntervalMs = Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_POLL_INTERVAL_MS;
    this._sleepAbortController?.abort();
  }

  private get stateStore(): ProxmoxStateStore {
    if (!this._stateStore) {
      if (this.injectedStateStore) this._stateStore = this.injectedStateStore;
      else if (this.db) this._stateStore = new ProxmoxStateRepository(this.db.getPool());
      else throw new Error(`${this.name} has no DatabaseClient to record its state with`);
    }
    return this._stateStore;
  }

  protected async collect(): Promise<void> {
    const client = this.clientProvider.getClient(this.proxmoxConfig);

    while (!this.signal.aborted) {
      const t0 = performance.now();

      let snapshot;
      try {
        snapshot = await client.getClusterSnapshot();
      } catch (err) {
        if (this.signal.aborted) return;
        const failure = err instanceof ProxmoxRequestError
          ? err
          : new ProxmoxRequestError('unreachable', 'poll', err instanceof Error ? err.message : String(err));
        await this.recordState(failure.kind, failure.message, failure.detail);
        throw failure;
      }

      const rows = snapshotToRows(snapshot, this.proxmoxConfig.host, this.rateTracker);

      this.dbDebugLog(
        `[${this.name}] Inserting ${rows.length} rows ` +
        `from ${snapshot.resources.length} cluster resources`
      );

      await this.repository.insertProxmoxStats(rows);
      this.lastSuccessAt = new Date();
      this.resetBackoff();
      await this.recordState('collecting', null, null);

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

  /**
   * `detail` is the reason without its request path: the two requests of a poll run together and
   * either can fail first, so comparing the full reason would rewrite and rebroadcast on every retry.
   */
  private async recordState(state: ProxmoxCollectorStateKind, reason: string | null, detail: string | null): Promise<void> {
    const now = Date.now();
    const prev = this.recorded;
    const unchanged = prev !== null && prev.state === state && prev.detail === detail;
    if (unchanged && (state !== 'collecting' || now - prev.at < LAST_SUCCESS_REFRESH_MS)) return;

    try {
      await this.stateStore.record({
        connectionId: proxmoxConnectionId(this.proxmoxConfig),
        host: this.proxmoxConfig.host,
        port: this.proxmoxConfig.port,
        state,
        reason,
        lastSuccessAt: this.lastSuccessAt,
      });
      this.recorded = { state, detail, at: now };
    } catch (err) {
      console.error(`[${this.name}] Failed to record Proxmox state ${state}:`, err instanceof Error ? err.message : err);
    }
  }
}

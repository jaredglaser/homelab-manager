import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import { StatsRepository, type RawStatRow } from '@/lib/database/repositories/stats-repository';
import { abortableSleep, isAbortError } from '@/lib/utils/abortable-sleep';

const MAX_BACKOFF_EXPONENT = 5; // max 32s
const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 500;
const RECONNECT_DELAY_MS = 1_000;

/**
 * Abstract base class for background stats collectors.
 * Implements AsyncDisposable for deterministic cleanup via `await using`.
 *
 * Subclasses implement:
 * - `name` — human-readable label for logging
 * - `collectOnce()` — single collection cycle (connect, stream, batch)
 * - `isConfigured()` — whether required env vars are present
 */
export abstract class BaseCollector implements AsyncDisposable {
  protected readonly repository: StatsRepository;
  protected readonly abortController: AbortController;
  protected readonly signal: AbortSignal;

  private batch: RawStatRow[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveErrors = 0;
  private lastWriteTime = new Map<string, number>();
  private _dockerDebugLogging = false;
  private _dbFlushDebugLogging = false;

  constructor(
    protected readonly db: DatabaseClient,
    protected readonly config: WorkerConfig,
    abortController?: AbortController,
  ) {
    this.repository = new StatsRepository(db.getPool());
    this.abortController = abortController ?? new AbortController();
    this.signal = this.abortController.signal;
  }

  abstract readonly name: string;

  /**
   * Run a single collection cycle. Implementations should:
   * - Connect to the data source
   * - Stream data, calling `addToBatch()` for each batch of rows
   * - Check `this.signal.aborted` periodically
   */
  protected abstract collectOnce(): Promise<void>;

  /** Check if required environment variables are configured */
  protected abstract isConfigured(): boolean;

  /**
   * Main entry point. Runs the collection loop until aborted.
   * Handles reconnection with exponential backoff on errors.
   */
  async run(): Promise<void> {
    console.log(`[${this.name}] Starting collection`);
    let cycleCount = 0;

    while (!this.signal.aborted) {
      try {
        if (!this.isConfigured()) {
          console.error(`[${this.name}] Configuration incomplete, waiting...`);
          await abortableSleep(RECONNECT_DELAY_MS, this.signal);
          continue;
        }

        cycleCount++;
        this.debugLog(`[${this.name}] Starting collection cycle #${cycleCount}`);
        const t0 = performance.now();

        await this.collectOnce();

        const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

        // Stream ended without error and we're not aborted — reconnect
        if (!this.signal.aborted) {
          this.debugLog(
            `[${this.name}] collectOnce() returned after ${elapsed}s` +
            ` (cycle #${cycleCount}), reconnecting in ${RECONNECT_DELAY_MS}ms...`
          );
          this.consecutiveErrors = 0;
          await abortableSleep(RECONNECT_DELAY_MS, this.signal);
        }
      } catch (err) {
        if (isAbortError(err) || this.signal.aborted) {
          break;
        }

        this.consecutiveErrors++;
        const exponent = Math.min(this.consecutiveErrors, MAX_BACKOFF_EXPONENT);
        const backoffMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, exponent), MAX_BACKOFF_MS);

        const errMsg = err instanceof Error ? err.message : String(err);
        const errCode = (err as any)?.code || 'unknown';
        console.error(
          `[${this.name}] Collection error (cycle #${cycleCount}):` +
          ` code=${errCode} message=${errMsg}`
        );
        this.debugLog(`[${this.name}] Retrying in ${backoffMs}ms (attempt ${this.consecutiveErrors})...`);

        try {
          await abortableSleep(backoffMs, this.signal);
        } catch {
          break; // Abort during backoff
        }
      }
    }

    await this.flushBatch();
    console.log(`[${this.name}] Stopped gracefully after ${cycleCount} cycles`);
  }

  /** Signal this collector to stop. */
  stop(): void {
    if (!this.signal.aborted) {
      this.abortController.abort(new DOMException('Collector stopped', 'AbortError'));
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.stop();
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    await this.flushBatch();
  }

  // --- Batch management ---

  protected addToBatch(rows: RawStatRow[]): void {
    this.batch.push(...rows);

    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => {
        this.batchTimer = null;
        this.flushBatch().catch(err => {
          console.error(`[${this.name}] Error in batch timeout flush:`, err);
        });
      }, this.config.batch.timeout);
    }
  }

  private async flushBatch(): Promise<void> {
    if (this.batch.length === 0) return;

    const count = this.batch.length;
    try {
      await this.repository.insertRawStats(this.batch);
      this.dbDebugLog(`[${this.name}] Flushed ${count} rows`);
      this.batch = [];
    } catch (err) {
      console.error(`[${this.name}] Failed to flush batch:`, err);
      this.batch = []; // Drop to avoid memory buildup
    }

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }

  /** Reset the error counter after a successful connection */
  protected resetBackoff(): void {
    this.consecutiveErrors = 0;
  }

  /**
   * Throttle writes per entity based on collection.interval config.
   * Returns true if enough time has elapsed since the last write for this entity.
   * Streams still run at native speed (rate calculators stay accurate),
   * but only 1-in-N samples is persisted to the database.
   */
  protected shouldWrite(entity: string): boolean {
    const now = Date.now();
    const lastWrite = this.lastWriteTime.get(entity) ?? 0;
    if (now - lastWrite < this.config.collection.interval) return false;
    this.lastWriteTime.set(entity, now);
    return true;
  }

  /** Enable or disable Docker debug logging at runtime via developer settings */
  set dockerDebugLogging(enabled: boolean) {
    this._dockerDebugLogging = enabled;
  }

  /** Enable or disable database flush debug logging at runtime via developer settings */
  set dbFlushDebugLogging(enabled: boolean) {
    this._dbFlushDebugLogging = enabled;
  }

  /** Log a message only when Docker debug logging is enabled */
  protected debugLog(message: string): void {
    if (this._dockerDebugLogging) {
      console.log(message);
    }
  }

  /** Log a message only when database flush debug logging is enabled */
  protected dbDebugLog(message: string): void {
    if (this._dbFlushDebugLogging) {
      console.log(message);
    }
  }
}

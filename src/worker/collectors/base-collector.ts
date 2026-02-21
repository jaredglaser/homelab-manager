import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import { StatsRepository } from '@/lib/database/repositories/stats-repository';
import { abortableSleep, isAbortError } from '@/lib/utils/abortable-sleep';

const MAX_BACKOFF_EXPONENT = 5; // max 32s
const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 500;

/**
 * Abstract base class for background stats collectors.
 * Implements AsyncDisposable for deterministic cleanup via `await using`.
 *
 * Subclasses implement:
 * - `name` — human-readable label for logging
 * - `collect()` — single collection cycle (connect, stream, write)
 */
export abstract class BaseCollector implements AsyncDisposable {
  protected readonly repository: StatsRepository;
  protected readonly abortController: AbortController;
  protected readonly signal: AbortSignal;

  private consecutiveErrors = 0;
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
   * Run collection until aborted or error. Implementations should:
   * - Connect to the data source
   * - Stream data continuously, writing rows via repository
   * - Check `this.signal.aborted` periodically
   * - Only return when aborted, error, or refresh needed (e.g., container changes)
   */
  protected abstract collect(): Promise<void>;

  /**
   * Main entry point. Runs the collection loop until aborted.
   * Handles reconnection with exponential backoff on errors.
   */
  async run(): Promise<void> {
    console.log(`[${this.name}] Starting collection`);
    let cycleCount = 0;

    while (!this.signal.aborted) {
      try {
        cycleCount++;
        this.debugLog(`[${this.name}] Starting collection cycle #${cycleCount}`);
        const t0 = performance.now();

        await this.collect();

        const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

        // Collection ended (container changes, error, or aborted) — reconnect immediately
        if (!this.signal.aborted) {
          this.debugLog(
            `[${this.name}] Collection ended after ${elapsed}s` +
            ` (cycle #${cycleCount}), reconnecting immediately...`
          );
          this.consecutiveErrors = 0;
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
  }

  /** Reset the error counter after a successful connection */
  protected resetBackoff(): void {
    this.consecutiveErrors = 0;
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

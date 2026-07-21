import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import { StatsRepository } from '@/lib/database/repositories/stats-repository';
import { abortableSleep, isAbortError } from '@/lib/utils/abortable-sleep';
import { backoffDelayMs } from '@/lib/utils/backoff';

const MAX_BACKOFF_EXPONENT = 5; // max 32s
const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 500;

// A cycle that ends cleanly but faster than this is treated as a failed
// connection, not a healthy stream that reached a refresh point. Without this
// floor, an agent that returns HTTP 200 then immediately closes the stream
// (e.g. its Docker daemon is down) drives a hot reconnect loop:
// fetch -> JWT sign -> 200 -> EOF -> refetch with no delay, burning CPU and
// hammering the agent for as long as the fault persists.
const MIN_HEALTHY_CYCLE_MS = 1000;

/**
 * Abstract base class for background stats collectors.
 * Implements AsyncDisposable for deterministic cleanup via `await using`.
 *
 * Subclasses implement:
 * - `name` - human-readable label for logging
 * - `collect()` - single collection cycle (connect, stream, write)
 */
export abstract class BaseCollector implements AsyncDisposable {
  protected readonly repository: StatsRepository;
  protected readonly abortController: AbortController;
  readonly signal: AbortSignal;

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

        if (this.signal.aborted) break;

        const elapsedMs = performance.now() - t0;
        if (elapsedMs >= MIN_HEALTHY_CYCLE_MS) {
          // Stream stayed up long enough to be healthy (e.g. it ended on a
          // container-change refresh); reconnect immediately.
          this.debugLog(
            `[${this.name}] Collection ended after ${(elapsedMs / 1000).toFixed(1)}s` +
            ` (cycle #${cycleCount}), reconnecting immediately...`
          );
          this.consecutiveErrors = 0;
        } else {
          // Ended almost instantly: throttle like an error to avoid a hot
          // reconnect loop (see MIN_HEALTHY_CYCLE_MS).
          this.consecutiveErrors++;
          this.debugLog(
            `[${this.name}] Collection ended after only ${Math.round(elapsedMs)}ms` +
            ` (cycle #${cycleCount}); backing off`
          );
          if (!(await this.backoffSleep())) break;
        }
      } catch (err) {
        if (isAbortError(err) || this.signal.aborted) {
          break;
        }

        this.consecutiveErrors++;
        const errMsg = err instanceof Error ? err.message : String(err);
        const errCode = (err as any)?.code || 'unknown';
        console.error(
          `[${this.name}] Collection error (cycle #${cycleCount}):` +
          ` code=${errCode} message=${errMsg}`
        );
        if (!(await this.backoffSleep())) break;
      }
    }

    console.log(`[${this.name}] Stopped gracefully after ${cycleCount} cycles`);
  }

  /**
   * Sleep for the current exponential-backoff window (based on
   * `consecutiveErrors`). Returns false if the signal aborted during the
   * sleep, in which case the caller should stop the loop.
   */
  private async backoffSleep(): Promise<boolean> {
    const backoffMs = backoffDelayMs(this.consecutiveErrors, {
      baseMs: BASE_BACKOFF_MS,
      capMs: MAX_BACKOFF_MS,
      maxExponent: MAX_BACKOFF_EXPONENT,
    });
    this.debugLog(`[${this.name}] Retrying in ${backoffMs}ms (attempt ${this.consecutiveErrors})...`);
    try {
      await abortableSleep(backoffMs, this.signal);
      return true;
    } catch {
      return false;
    }
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

import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import { StatsRepository } from '@/lib/database/repositories/stats-repository';
import { abortableSleep, isAbortError } from '@/lib/utils/abortable-sleep';
import { backoffDelayMs } from '@/lib/utils/backoff';

const MAX_BACKOFF_EXPONENT = 5; // max 32s
const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 500;

// Floor below which a clean cycle end is treated as a failed connection, not a healthy
// refresh; otherwise an agent that returns 200 then immediately closes the stream drives
// a hot reconnect loop.
const MIN_HEALTHY_CYCLE_MS = 1000;

/** Abstract base for background stats collectors; implements AsyncDisposable for cleanup via `await using`. */
export abstract class BaseCollector implements AsyncDisposable {
  protected readonly abortController: AbortController;
  readonly signal: AbortSignal;

  private consecutiveErrors = 0;
  private _dockerDebugLogging = false;
  private _dbFlushDebugLogging = false;
  private _repository: StatsRepository | undefined;

  constructor(
    protected readonly db: DatabaseClient | undefined,
    protected readonly config: WorkerConfig | undefined,
    abortController?: AbortController,
  ) {
    this.abortController = abortController ?? new AbortController();
    this.signal = this.abortController.signal;
  }

  abstract readonly name: string;

  /** Built lazily so collectors without a DatabaseClient (e.g. ContainerInventoryCollector) don't need one. */
  protected get repository(): StatsRepository {
    if (!this.db) {
      throw new Error(`${this.constructor.name} has no DatabaseClient to build a StatsRepository from`);
    }
    if (!this._repository) {
      this._repository = new StatsRepository(this.db.getPool());
    }
    return this._repository;
  }

  /** Single collection cycle: connect, stream rows via repository, return only when aborted, erroring, or needing a refresh. */
  protected abstract collect(): Promise<void>;

  /** Runs the collection loop until aborted, reconnecting with exponential backoff on errors. */
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
          // Healthy-length cycle (e.g. a container-change refresh); reconnect immediately.
          this.debugLog(
            `[${this.name}] Collection ended after ${(elapsedMs / 1000).toFixed(1)}s` +
            ` (cycle #${cycleCount}), reconnecting immediately...`
          );
          this.consecutiveErrors = 0;
        } else {
          // Ended almost instantly: throttle like an error (see MIN_HEALTHY_CYCLE_MS).
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

  /** Sleeps for the current backoff window; returns false if aborted during the sleep. */
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

  protected debugLog(message: string): void {
    if (this._dockerDebugLogging) {
      console.log(message);
    }
  }

  protected dbDebugLog(message: string): void {
    if (this._dbFlushDebugLogging) {
      console.log(message);
    }
  }
}

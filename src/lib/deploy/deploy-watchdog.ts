import type { DeployRepository } from '@/lib/database/repositories/deploy-repository';

export interface DeployWatchdogConfig {
  /** How often to check for stuck deploys. */
  intervalMs: number;
  /** How long an in_progress deploy may sit before being failed. */
  thresholdMinutes: number;
}

const DEFAULT_INTERVAL_MS = 2 * 60 * 1000;
const DEFAULT_THRESHOLD_MINUTES = 30;

/**
 * Load DeployWatchdog config from environment variables, falling back to sensible
 * defaults (2 minute interval, 30 minute threshold).
 */
export function loadDeployWatchdogConfig(): DeployWatchdogConfig {
  return {
    intervalMs: parsePositiveInt(process.env.DEPLOY_WATCHDOG_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    thresholdMinutes: parsePositiveInt(process.env.DEPLOY_WATCHDOG_TIMEOUT_MINUTES, DEFAULT_THRESHOLD_MINUTES),
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Periodic background job that fails deploys stuck in `in_progress` longer than
 * the configured threshold. Recovery on startup is handled separately in
 * `server-init.ts` via `DeployRepository.recoverStuckDeploys`.
 */
export class DeployWatchdog {
  private readonly config: DeployWatchdogConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(config: DeployWatchdogConfig = loadDeployWatchdogConfig()) {
    this.config = config;
  }

  /** Start the periodic check. Safe to call multiple times; extra calls are no-ops. */
  start(deployRepo: DeployRepository): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick(deployRepo);
    }, this.config.intervalMs);
  }

  /** Stop the periodic check. Safe to call when not started. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Execute a single sweep. Exposed so callers (and tests) can trigger manually.
   * Reentrancy-guarded — if a previous tick is still running, subsequent calls
   * return immediately.
   */
  async tick(deployRepo: DeployRepository): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const message = buildTimeoutMessage(this.config.thresholdMinutes);
      const timedOut = await deployRepo.timeoutStuckDeploys(this.config.thresholdMinutes, message);
      if (timedOut.length === 0) return;

      console.info(
        `[DeployWatchdog] Timed out ${timedOut.length} deploy(s) exceeding ${this.config.thresholdMinutes}min threshold`,
      );
      for (const row of timedOut) {
        try {
          await deployRepo.notifyStackChange(row.stack, row.host);
        } catch (err) {
          console.error(
            `[DeployWatchdog] Failed to notify stack change for ${row.stack}/${row.host}:`,
            err,
          );
        }
      }
    } catch (err) {
      console.error('[DeployWatchdog] Tick failed:', err);
    } finally {
      this.running = false;
    }
  }
}

function buildTimeoutMessage(minutes: number): string {
  return `Deploy marked failed by watchdog — no completion signal received after ${minutes} minutes. The deploy may still be running on the host; check the agent before re-triggering.`;
}

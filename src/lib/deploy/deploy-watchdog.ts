import type { DeployRepository } from '@/lib/database/repositories/deploy-repository';

export type WatchdogRepo = Pick<DeployRepository, 'timeoutStuckDeploys' | 'notifyStackChange'>;

export interface DeployWatchdogConfig {
  /** How often to check for stuck deploys. Must be > 0. */
  intervalMs: number;
  /** How long an in_progress deploy may sit before being failed. Must be > 0. */
  thresholdMinutes: number;
}

const DEFAULT_INTERVAL_MS = 2 * 60 * 1000;
const DEFAULT_THRESHOLD_MINUTES = 10;
const FAILURE_ESCALATION_THRESHOLD = 3;

/**
 * Defaults: 2 min interval / 10 min threshold — ~2× the agent's 5-min compose
 * subprocess cap, so deploys still in_progress past this point mean the
 * failure path itself got lost.
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

/** Periodic sweep that fails deploys stuck in `in_progress` past the threshold. */
export class DeployWatchdog {
  private readonly config: DeployWatchdogConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private consecutiveFailures = 0;

  constructor(config: DeployWatchdogConfig = loadDeployWatchdogConfig()) {
    if (config.intervalMs <= 0 || !Number.isFinite(config.intervalMs)) {
      throw new Error(`DeployWatchdog: intervalMs must be > 0, got ${config.intervalMs}`);
    }
    if (config.thresholdMinutes <= 0 || !Number.isFinite(config.thresholdMinutes)) {
      throw new Error(`DeployWatchdog: thresholdMinutes must be > 0, got ${config.thresholdMinutes}`);
    }
    this.config = config;
  }

  /** Idempotent — extra calls are no-ops. */
  start(deployRepo: WatchdogRepo): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick(deployRepo);
    }, this.config.intervalMs);
  }

  /** Idempotent — safe to call before start. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposed for observability — number of consecutive tick failures. Resets to 0 on success. */
  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  /** Reentrancy-guarded — if a previous tick is still running, returns immediately. */
  async tick(deployRepo: WatchdogRepo): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const message = buildTimeoutMessage(this.config.thresholdMinutes);
      const timedOut = await deployRepo.timeoutStuckDeploys(this.config.thresholdMinutes, message);
      this.consecutiveFailures = 0;
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
      this.consecutiveFailures += 1;
      const prefix = this.consecutiveFailures >= FAILURE_ESCALATION_THRESHOLD
        ? `[DeployWatchdog] Tick failed (${this.consecutiveFailures} consecutive failures — watchdog degraded)`
        : '[DeployWatchdog] Tick failed';
      console.error(`${prefix}:`, err);
    } finally {
      this.running = false;
    }
  }
}

function buildTimeoutMessage(minutes: number): string {
  return `Deploy marked failed by watchdog — no completion signal received after ${minutes} minutes. The deploy may still be running on the host; check the agent before re-triggering.`;
}

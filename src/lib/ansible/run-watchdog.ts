import type { AnsibleBroadcastEvent } from '@/lib/ansible/run-broadcast-service';
import type { AnsibleRunRepository } from '@/lib/database/repositories/ansible-run-repository';

export type AnsibleWatchdogRepo = Pick<AnsibleRunRepository, 'timeoutStuckRuns'>;

export type AnsibleRunPublish = (event: AnsibleBroadcastEvent) => void;

export interface AnsibleRunWatchdogConfig {
  /** How often to check for stuck runs. Must be > 0. */
  intervalMs: number;
  /** How long a run may go without events before being failed. Must be > 0. */
  thresholdMinutes: number;
}

const DEFAULT_INTERVAL_MS = 2 * 60 * 1000;
const DEFAULT_THRESHOLD_MINUTES = 15;
const FAILURE_ESCALATION_THRESHOLD = 3;

/**
 * Defaults: 2 min interval / 15 min threshold (1.5x the sidecar's 600s
 * `ANSIBLE_IDLE_TIMEOUT_SECONDS`), so the sidecar resolves a silent run through its
 * own idle cap first. Raising that cap without raising this fails live runs.
 */
export function loadAnsibleRunWatchdogConfig(): AnsibleRunWatchdogConfig {
  return {
    intervalMs: parsePositiveInt(process.env.ANSIBLE_WATCHDOG_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    thresholdMinutes: parsePositiveInt(
      process.env.ANSIBLE_WATCHDOG_TIMEOUT_MINUTES,
      DEFAULT_THRESHOLD_MINUTES,
    ),
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Periodic sweep that fails Ansible runs left non-terminal past the threshold. */
export class AnsibleRunWatchdog {
  private readonly config: AnsibleRunWatchdogConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private consecutiveFailures = 0;
  private skippedTicks = 0;

  constructor(config: AnsibleRunWatchdogConfig = loadAnsibleRunWatchdogConfig()) {
    if (config.intervalMs <= 0 || !Number.isFinite(config.intervalMs)) {
      throw new Error(`AnsibleRunWatchdog: intervalMs must be > 0, got ${config.intervalMs}`);
    }
    if (config.thresholdMinutes <= 0 || !Number.isFinite(config.thresholdMinutes)) {
      throw new Error(
        `AnsibleRunWatchdog: thresholdMinutes must be > 0, got ${config.thresholdMinutes}`,
      );
    }
    this.config = config;
  }

  /** Idempotent: extra calls are no-ops. */
  start(repo: AnsibleWatchdogRepo, publish: AnsibleRunPublish): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick(repo, publish);
    }, this.config.intervalMs);
  }

  /** Idempotent: safe to call before start. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposed for observability: number of consecutive tick failures. Resets to 0 on success. */
  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  /** Exposed for observability: total ticks dropped because a prior tick was still running. */
  getSkippedTicks(): number {
    return this.skippedTicks;
  }

  /** Reentrancy-guarded: if a previous tick is still running, logs and returns. */
  async tick(repo: AnsibleWatchdogRepo, publish: AnsibleRunPublish): Promise<void> {
    if (this.running) {
      this.skippedTicks += 1;
      console.info(
        `[AnsibleRunWatchdog] Skipped tick (already running, skipped=${this.skippedTicks})`,
      );
      return;
    }
    this.running = true;
    try {
      const timedOut = await repo.timeoutStuckRuns(this.config.thresholdMinutes);
      this.consecutiveFailures = 0;
      if (timedOut.length === 0) return;

      console.info(
        `[AnsibleRunWatchdog] ${buildTimeoutMessage(this.config.thresholdMinutes)} Runs: ${timedOut
          .map((row) => row.runId)
          .join(', ')}`,
      );
      for (const row of timedOut) {
        try {
          publish({ type: 'run_finished', runId: row.runId, status: 'failed' });
        } catch (err) {
          console.error(
            `[AnsibleRunWatchdog] Failed to publish run_finished for ${row.runId}:`,
            err,
          );
        }
      }
    } catch (err) {
      this.consecutiveFailures += 1;
      const prefix =
        this.consecutiveFailures >= FAILURE_ESCALATION_THRESHOLD
          ? `[AnsibleRunWatchdog] Tick failed (${this.consecutiveFailures} consecutive failures, watchdog degraded)`
          : '[AnsibleRunWatchdog] Tick failed';
      console.error(`${prefix}:`, err);
    } finally {
      this.running = false;
    }
  }
}

function buildTimeoutMessage(minutes: number): string {
  return `Run(s) marked failed by watchdog: no events received for ${minutes} minutes. The play may still be executing on the host; check before re-triggering.`;
}

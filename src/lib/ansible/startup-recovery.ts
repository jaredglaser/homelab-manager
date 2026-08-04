import type { AnsibleRunPublish, AnsibleWatchdogRepo } from '@/lib/ansible/run-watchdog';
import type { StrandedAnsibleRunRow } from '@/lib/database/repositories/ansible-run-repository';
import { retry } from '@/lib/utils/backoff';

export interface AnsibleStartupRecoveryRepo extends AnsibleWatchdogRepo {
  failStrandedRuns(): Promise<StrandedAnsibleRunRow[]>;
}

export interface AnsibleWatchdogController {
  start(repo: AnsibleWatchdogRepo, publish: AnsibleRunPublish): void;
}

export interface AnsibleStartupRecoveryOptions {
  /** Aborts the retry loop during graceful shutdown. */
  signal?: AbortSignal;
}

const MAX_ATTEMPTS = 3;

/**
 * Retries `failStrandedRuns` on transient errors, publishes a terminal transition for each
 * recovered run so a browser whose EventSource outlived the restart unsticks, then starts
 * the watchdog. The watchdog starts even if recovery ultimately fails so future sweeps
 * still happen.
 */
export async function performAnsibleRunRecovery(
  repo: AnsibleStartupRecoveryRepo,
  watchdog: AnsibleWatchdogController,
  publish: AnsibleRunPublish,
  options: AnsibleStartupRecoveryOptions = {},
): Promise<void> {
  try {
    const recovered = await retry(() => repo.failStrandedRuns(), {
      maxAttempts: MAX_ATTEMPTS,
      isRetryable: () => true,
      signal: options.signal,
      onRetry: (err, attempt) => {
        console.error(
          `[Ansible] Startup run recovery attempt ${attempt}/${MAX_ATTEMPTS} failed:`,
          err,
        );
      },
    });

    if (recovered.length > 0) {
      console.info(
        `[Ansible] Failed ${recovered.length} stranded run(s) from a prior process: ${recovered
          .map((row) => row.runId)
          .join(', ')}`,
      );
      for (const row of recovered) {
        try {
          publish({ type: 'run_finished', runId: row.runId, status: 'failed' });
        } catch (err) {
          console.error(`[Ansible] Failed to publish run_finished for ${row.runId}:`, err);
        }
      }
    }
  } catch (err) {
    console.error(
      `[Ansible] Startup run recovery exhausted after ${MAX_ATTEMPTS} attempts, watchdog will keep retrying:`,
      err,
    );
  }

  watchdog.start(repo, publish);
}

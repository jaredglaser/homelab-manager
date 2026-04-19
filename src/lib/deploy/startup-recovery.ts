import type { StuckDeployRow } from '@/lib/database/repositories/deploy-repository';
import type { WatchdogRepo } from '@/lib/deploy/deploy-watchdog';

export interface StartupRecoveryRepo extends WatchdogRepo {
  recoverStuckDeploys(logMessage: string): Promise<StuckDeployRow[]>;
}

export interface WatchdogController {
  start(repo: WatchdogRepo): void;
}

export interface StartupRecoveryOptions {
  maxAttempts?: number;
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
}

export const STARTUP_RECOVERY_MESSAGE =
  'Deploy interrupted — server restarted while this deploy was in progress. The actual outcome on the host is unknown. Please verify stack status and re-trigger if needed.';

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 500;

/**
 * Orchestrates startup recovery: retry `recoverStuckDeploys` on transient errors,
 * broadcast stack changes for recovered rows, then start the watchdog. The watchdog
 * is started even if recovery ultimately fails so future recoveries still happen.
 */
export async function performStartupRecovery(
  repo: StartupRecoveryRepo,
  watchdog: WatchdogController,
  options: StartupRecoveryOptions = {},
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoff = options.backoffMs ?? ((attempt) => DEFAULT_BACKOFF_MS * 2 ** attempt);
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

  try {
    const recovered = await runWithRetry(
      () => repo.recoverStuckDeploys(STARTUP_RECOVERY_MESSAGE),
      { maxAttempts, backoff, sleep, onAttemptFailed: (attempt, err) => {
        console.error(`[Server] Startup recovery attempt ${attempt}/${maxAttempts} failed:`, err);
      } },
    );

    if (recovered.length > 0) {
      console.info(`[Server] Recovered ${recovered.length} stuck deploy(s) on startup`);
      for (const r of recovered) {
        try {
          await repo.notifyStackChange(r.stack, r.host);
        } catch (err) {
          console.error(`[Server] Failed to notify stack change for ${r.stack}/${r.host}:`, err);
        }
      }
    }
  } catch (err) {
    console.error(
      `[Server] Startup recovery exhausted after ${maxAttempts} attempts — watchdog will keep retrying:`,
      err,
    );
  }

  watchdog.start(repo);
}

// TODO: migrate to the shared retry() utility from @/lib/utils/backoff
async function runWithRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxAttempts: number;
    backoff: (attempt: number) => number;
    sleep: (ms: number) => Promise<void>;
    onAttemptFailed: (attempt: number, err: unknown) => void;
  },
): Promise<T> {
  const attempts = Math.max(1, Math.floor(opts.maxAttempts));
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      opts.onAttemptFailed(attempt, err);
      if (attempt < attempts) await opts.sleep(opts.backoff(attempt - 1));
    }
  }
  throw lastErr;
}

import type { PostSuccessDeployRow, StuckDeployRow } from '@/lib/database/repositories/deploy-repository';
import type { WatchdogRepo } from '@/lib/deploy/deploy-watchdog';
import type { StackRepoWriter } from '@/lib/deploy/pipeline';
import { retry } from '@/lib/utils/backoff';

export interface StartupRecoveryRepo extends WatchdogRepo {
  // Fails ALL pending/in_progress rows, so it is safe only when exactly one
  // web process runs against the database.
  recoverStuckDeploys(logMessage: string): Promise<StuckDeployRow[]>;
  findSucceededPostSuccessDeploys(kind: 'removeFromManifest'): Promise<PostSuccessDeployRow[]>;
}

export interface WatchdogController {
  start(repo: WatchdogRepo): void;
}

/**
 * Narrow view of the manifest required by the orphaned-sweep. Kept separate
 * from the git module so tests don't pull in isomorphic-git.
 */
export interface ManifestReader {
  listStackNames(): Promise<Set<string>>;
}

export interface StartupRecoveryOptions {
  /** Aborts the retry loop during graceful shutdown. */
  signal?: AbortSignal;
  /** Optional: enables the orphaned manifest-delete sweep. */
  manifestReader?: ManifestReader;
  /** Optional: writer used by the orphaned sweep to remove manifest entries. */
  stackRepoWriter?: StackRepoWriter;
}

export const STARTUP_RECOVERY_MESSAGE =
  'Deploy interrupted: server restarted while this deploy was in progress. The actual outcome on the host is unknown. Please verify stack status and re-trigger if needed.';

const MAX_ATTEMPTS = 3;

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
  try {
    const recovered = await retry(
      () => repo.recoverStuckDeploys(STARTUP_RECOVERY_MESSAGE),
      {
        maxAttempts: MAX_ATTEMPTS,
        isRetryable: () => true,
        signal: options.signal,
        onRetry: (err, attempt) => {
          console.error(`[Server] Startup recovery attempt ${attempt}/${MAX_ATTEMPTS} failed:`, err);
        },
      },
    );

    if (recovered.length > 0) {
      console.info(`[Server] Recovered ${recovered.length} stuck deploy(s) on startup`);
      for (const r of recovered) {
        try {
          await repo.notifyStackChange(r.stack, r.host, {
            deployId: r.id,
            status: 'failed',
            action: r.action,
            trigger: r.trigger,
            message: STARTUP_RECOVERY_MESSAGE,
          });
        } catch (err) {
          console.error(`[Server] Failed to notify stack change for ${r.stack}/${r.host}:`, err);
        }
      }
    }
  } catch (err) {
    console.error(
      `[Server] Startup recovery exhausted after ${MAX_ATTEMPTS} attempts, watchdog will keep retrying:`,
      err,
    );
  }

  // Second pass: orphaned manifest-delete sweep. Runs best-effort; a failure
  // here must not prevent the watchdog from starting.
  if (options.manifestReader && options.stackRepoWriter) {
    try {
      await sweepOrphanedManifestDeletes(repo, options.manifestReader, options.stackRepoWriter);
    } catch (err) {
      console.error('[Server] Orphaned manifest-delete sweep failed:', err);
    }
  }

  watchdog.start(repo);
}

/**
 * Finds rows where teardown succeeded with postSuccess='removeFromManifest'
 * but the stack is still in the manifest (process crashed between the
 * agent ACK and the manifest delete). Runs the manifest delete for each.
 * Idempotent: skips stacks that are no longer in the manifest.
 */
async function sweepOrphanedManifestDeletes(
  repo: StartupRecoveryRepo,
  manifestReader: ManifestReader,
  stackRepoWriter: StackRepoWriter,
): Promise<void> {
  const orphaned = await repo.findSucceededPostSuccessDeploys('removeFromManifest');
  if (orphaned.length === 0) return;

  // Deduplicate: a stack may have multiple succeeded teardown rows over time.
  const seen = new Set<string>();
  const uniqueStacks: PostSuccessDeployRow[] = [];
  for (const row of orphaned) {
    if (seen.has(row.stack)) continue;
    seen.add(row.stack);
    uniqueStacks.push(row);
  }

  let manifestStacks: Set<string>;
  try {
    manifestStacks = await manifestReader.listStackNames();
  } catch (err) {
    console.error('[Server] Failed to read manifest during orphaned-sweep, aborting sweep:', err);
    return;
  }

  let removed = 0;
  for (const row of uniqueStacks) {
    if (!manifestStacks.has(row.stack)) continue; // already gone, skip
    try {
      await stackRepoWriter.removeStackFromManifest(row.stack);
      removed += 1;
    } catch (err) {
      console.error(
        `[Server] Orphaned manifest-delete failed for stack "${row.stack}":`,
        err,
      );
    }
  }

  if (removed > 0) {
    console.info(`[Server] Orphaned sweep removed ${removed} stack(s) from manifest`);
  }
}

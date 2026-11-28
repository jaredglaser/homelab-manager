import type { DatabaseClient } from '@/lib/clients/database-client';
import { runMigrations } from '@/lib/database/migrate';
import { runStatsRollupBackfill } from '@/lib/database/stats-rollup-backfill';

export interface PrepareDatabaseDeps {
  migrate?: typeof runMigrations;
  backfill?: typeof runStatsRollupBackfill;
}

/**
 * Migrates, runs `beforeBackfill`, then starts the rollup backfill without waiting for it. The web
 * server runs the backfill at boot too, possibly against an aggregate a migration here then rebuilds
 * empty, so this run waits for that one's lock instead of skipping.
 */
export async function prepareDatabase(
  db: DatabaseClient,
  shutdown: AbortSignal,
  beforeBackfill: () => Promise<void>,
  deps: PrepareDatabaseDeps = {},
): Promise<{ backfill: Promise<void> }> {
  await (deps.migrate ?? runMigrations)(db);
  await beforeBackfill();
  const backfill = (deps.backfill ?? runStatsRollupBackfill)(db, { waitForLock: { signal: shutdown } }).catch((err: unknown) => {
    console.error('[Worker] Stats rollup backfill failed:', err);
  });
  return { backfill };
}

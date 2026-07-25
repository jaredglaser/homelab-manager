import type { DatabaseClient } from '@/lib/clients/database-client';
import type { PoolClient } from 'pg';

/**
 * Advisory lock key ("hlm2" in ASCII) that serializes the rollup backfill. Distinct from
 * MIGRATIONS_ADVISORY_LOCK_KEY so a long backfill never blocks a migrating process.
 */
export const STATS_BACKFILL_ADVISORY_LOCK_KEY = 0x686c6d32;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

interface Tier {
  suffix: string;
  bucketMs: number;
  windowMs: number;
}

const TIERS: Tier[] = [
  { suffix: '_1m', bucketMs: MINUTE_MS, windowMs: 2 * DAY_MS },
  { suffix: '_1h', bucketMs: HOUR_MS, windowMs: 6 * DAY_MS },
];

const SOURCE_TABLES = ['docker_stats', 'zfs_stats', 'proxmox_stats'];

interface RefreshWindow {
  startMs: number;
  /** `null` means the window runs to the database's `now()`. */
  endMs: number | null;
}

/**
 * Materializes the `_1m` and `_1h` continuous aggregates over all existing history, then
 * puts the raw and `_1m` retention policies in place. Migration 007 removed retention
 * entirely, so an upgraded deployment holds months of raw rows that a retention policy
 * would drop before they were ever rolled up.
 */
export async function runStatsRollupBackfill(db: DatabaseClient): Promise<void> {
  const client = await db.getPool().connect();
  try {
    const acquired = await tryAcquireLock(client);
    if (!acquired) {
      console.info('[StatsBackfill] Another process holds the lock, skipping');
      return;
    }

    try {
      for (const table of SOURCE_TABLES) {
        await backfillSource(client, table);
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [STATS_BACKFILL_ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

async function tryAcquireLock(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ acquired: boolean }>(
    'SELECT pg_try_advisory_lock($1) AS acquired',
    [STATS_BACKFILL_ADVISORY_LOCK_KEY],
  );
  return result.rows[0]?.acquired === true;
}

async function backfillSource(client: PoolClient, table: string): Promise<void> {
  try {
    if (!(await rollupsExist(client, table))) {
      console.info(`[StatsBackfill] ${table} rollups do not exist yet, skipping`);
      return;
    }

    const minTimeMs = await earliestSample(client, table);
    if (minTimeMs === null) {
      console.info(`[StatsBackfill] ${table} holds no rows, nothing to materialize`);
    } else {
      // _1h reads _1m, so the minute tier has to finish first.
      for (const tier of TIERS) {
        await refreshTier(client, `${table}${tier.suffix}`, minTimeMs, tier);
      }
    }

    await addRetentionPolicies(client, table);
    console.info(`[StatsBackfill] ${table} done`);
  } catch (err) {
    console.error(`[StatsBackfill] ${table} failed, retention left unapplied:`, err);
  }
}

async function rollupsExist(client: PoolClient, table: string): Promise<boolean> {
  const result = await client.query<{ ready: boolean }>(
    'SELECT (to_regclass($1) IS NOT NULL AND to_regclass($2) IS NOT NULL) AS ready',
    [`${table}_1m`, `${table}_1h`],
  );
  return result.rows[0]?.ready === true;
}

async function earliestSample(client: PoolClient, table: string): Promise<number | null> {
  const result = await client.query<{ min_time: Date | string | null }>(
    `SELECT min(time) AS min_time FROM ${table}`,
  );
  const minTime = result.rows[0]?.min_time ?? null;
  return minTime === null ? null : new Date(minTime).getTime();
}

async function refreshTier(
  client: PoolClient,
  view: string,
  minTimeMs: number,
  tier: Tier,
): Promise<void> {
  const windows = refreshWindows(minTimeMs, Date.now(), tier);
  if (windows.length === 0) {
    console.info(`[StatsBackfill] ${view} has less than one bucket of history, skipping`);
    return;
  }

  console.info(
    `[StatsBackfill] ${view}: ${windows.length} window(s) from ${new Date(windows[0].startMs).toISOString()}`,
  );

  for (const [index, window] of windows.entries()) {
    const start = timestampLiteral(window.startMs);
    const end = window.endMs === null ? 'now()' : timestampLiteral(window.endMs);
    console.info(`[StatsBackfill] ${view} window ${index + 1}/${windows.length}: ${start} -> ${end}`);
    await client.query(`CALL refresh_continuous_aggregate('${view}', ${start}, ${end})`);
  }
}

/**
 * Windows are bucket-aligned and never narrower than one bucket, which
 * refresh_continuous_aggregate rejects; the sub-bucket tail is left to the refresh policy.
 */
function refreshWindows(minTimeMs: number, nowMs: number, tier: Tier): RefreshWindow[] {
  const windows: RefreshWindow[] = [];
  const first = Math.floor(minTimeMs / tier.bucketMs) * tier.bucketMs;

  for (let start = first; nowMs - start >= tier.bucketMs; start += tier.windowMs) {
    const end = start + tier.windowMs;
    windows.push({ startMs: start, endMs: end < nowMs ? end : null });
  }

  return windows;
}

/**
 * Literal bounds rather than bind parameters: parameters would send the CALL over the
 * extended protocol, and refresh_continuous_aggregate has to be the sole statement of a
 * simple-protocol query to run outside a transaction block.
 */
function timestampLiteral(ms: number): string {
  return `'${new Date(ms).toISOString()}'::timestamptz`;
}

async function addRetentionPolicies(client: PoolClient, table: string): Promise<void> {
  await client.query(
    `SELECT add_retention_policy('${table}_1m', INTERVAL '30 days', if_not_exists => TRUE)`,
  );
  await client.query(
    `SELECT add_retention_policy('${table}', INTERVAL '24 hours', if_not_exists => TRUE)`,
  );
}

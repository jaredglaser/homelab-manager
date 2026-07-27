import type { Pool } from 'pg';
import type { Checks } from './checks';
import {
  ACTIVE_CONTAINER,
  COUNTER_BUCKET_SAMPLES,
  COUNTER_GUEST,
  DOCKER_HOST,
  EXPECTED_HYPERTABLES,
  EXPECTED_TABLES,
  IDLE_CONTAINER,
  PROXMOX_HOST,
  REMOVED_COLUMNS,
  SPARSE_HOUR,
  ZFS_HOST,
  sparseHourNaiveAverage,
  sparseHourRawAverage,
} from './fixture';

const WEIGHTED_EPSILON = 1e-9;
const MIN_DISCRIMINATION = 0.5;

const EXPECTED_SEGMENTBY: Record<string, string[]> = {
  docker_stats: ['host', 'container_id'],
  zfs_stats: ['host', 'pool', 'entity'],
  proxmox_stats: ['host', 'entity_type', 'entity_id'],
  docker_container_events: ['host', 'container_id'],
};

/**
 * Registry of continuous-aggregate tiers. `assertAggregateTiers` enforces that
 * the database's set of continuous aggregates matches this list exactly.
 */
export interface AggregateTier {
  view: string;
  sourceTable: string;
  timeColumn: string;
  sampleCountColumn: string;
  weightedAverageColumns: string[];
  lastValueColumns: string[];
}

/**
 * Both column lists are empty on every tier: the generic checks below filter the
 * source on `container_id` or `entity_id`, truncate the bucket bound to the hour,
 * and read one column name from both view and source, none of which holds for a
 * minute tier, a zfs tier, or the hourly tiers' `<metric>_sum` columns. The
 * aggregates are also created `WITH NO DATA`, so the harness sees them unpopulated.
 */
export const AGGREGATE_TIERS: AggregateTier[] = [
  {
    view: 'docker_stats_1m',
    sourceTable: 'docker_stats',
    timeColumn: 'time',
    sampleCountColumn: 'sample_count',
    weightedAverageColumns: [],
    lastValueColumns: [],
  },
  {
    view: 'docker_stats_1h',
    sourceTable: 'docker_stats_1m',
    timeColumn: 'time',
    sampleCountColumn: 'sample_count',
    weightedAverageColumns: [],
    lastValueColumns: [],
  },
  {
    view: 'zfs_stats_1m',
    sourceTable: 'zfs_stats',
    timeColumn: 'time',
    sampleCountColumn: 'sample_count',
    weightedAverageColumns: [],
    lastValueColumns: [],
  },
  {
    view: 'zfs_stats_1h',
    sourceTable: 'zfs_stats_1m',
    timeColumn: 'time',
    sampleCountColumn: 'sample_count',
    weightedAverageColumns: [],
    lastValueColumns: [],
  },
  {
    view: 'proxmox_stats_1m',
    sourceTable: 'proxmox_stats',
    timeColumn: 'time',
    sampleCountColumn: 'sample_count',
    weightedAverageColumns: [],
    lastValueColumns: [],
  },
  {
    view: 'proxmox_stats_1h',
    sourceTable: 'proxmox_stats_1m',
    timeColumn: 'time',
    sampleCountColumn: 'sample_count',
    weightedAverageColumns: [],
    lastValueColumns: [],
  },
];

export async function assertSchema(pool: Pool, checks: Checks): Promise<void> {
  const tables = await selectColumn<string>(
    pool,
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
  );
  checks.containsAll('expected tables exist', tables, EXPECTED_TABLES);

  const hypertables = await selectColumn<string>(
    pool,
    'SELECT hypertable_name FROM timescaledb_information.hypertables'
  );
  checks.containsAll('expected hypertables exist', hypertables, EXPECTED_HYPERTABLES);

  for (const { table, column } of REMOVED_COLUMNS) {
    const present = await selectColumn<string>(
      pool,
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [table, column]
    );
    checks.equal(`${table}.${column} was removed`, present.length, 0);
  }

  const zfsHost = await selectRow<{ is_nullable: string }>(
    pool,
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'zfs_stats' AND column_name = 'host'`
  );
  checks.equal('zfs_stats.host is NOT NULL', zfsHost?.is_nullable, 'NO');

  for (const column of ['netin', 'netout', 'uptime']) {
    const info = await selectRow<{ data_type: string }>(
      pool,
      `SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'proxmox_stats' AND column_name = $1`,
      [column]
    );
    checks.equal(`proxmox_stats.${column} is bigint`, info?.data_type, 'bigint');
  }

  const validStatus = await selectRow<{ definition: string }>(
    pool,
    `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
     WHERE conname = 'valid_status' AND conrelid = 'deploy_history'::regclass`
  );
  checks.equal(
    'deploy_history valid_status allows queued',
    validStatus?.definition.includes("'queued'"),
    true
  );

  const activeIndex = await selectRow<{ indexdef: string }>(
    pool,
    `SELECT indexdef FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'idx_deploy_one_active_per_stack_host'`
  );
  checks.equal(
    'active-deploy index is a partial unique index',
    activeIndex?.indexdef.includes('UNIQUE') && activeIndex?.indexdef.includes('WHERE'),
    true
  );

  await assertCompressionSettings(pool, checks);
  await assertNoRetentionPolicies(pool, checks);
}

async function assertCompressionSettings(pool: Pool, checks: Checks): Promise<void> {
  for (const [table, expected] of Object.entries(EXPECTED_SEGMENTBY)) {
    const segmentBy = await selectColumn<string>(
      pool,
      `SELECT attname FROM timescaledb_information.compression_settings
       WHERE hypertable_name = $1 AND segmentby_column_index IS NOT NULL
       ORDER BY segmentby_column_index`,
      [table]
    );
    checks.sameSet(`${table} compression segments by expected columns`, segmentBy, expected);
  }
}

/**
 * Migration 007 removed the 7-day retention policies. A policy reintroduced by
 * accident would silently delete the 31-day-old idle-container rows this
 * fixture depends on, which is the failure this check exists to catch.
 */
async function assertNoRetentionPolicies(pool: Pool, checks: Checks): Promise<void> {
  const withRetention = await selectColumn<string>(
    pool,
    `SELECT hypertable_name FROM timescaledb_information.jobs
     WHERE proc_name = 'policy_retention' AND hypertable_name IS NOT NULL`
  );
  checks.equal(
    'no retention policy on stats hypertables',
    withRetention.filter(name => EXPECTED_HYPERTABLES.includes(name)).join(',') || 'none',
    'none'
  );
}

export interface RowCountSnapshot {
  [label: string]: number;
}

export async function captureRowCounts(pool: Pool): Promise<RowCountSnapshot> {
  const snapshot: RowCountSnapshot = {};
  const dockerContainers = [ACTIVE_CONTAINER.id, IDLE_CONTAINER.id, SPARSE_HOUR.containerId];
  for (const containerId of dockerContainers) {
    snapshot[`docker_stats/${containerId}`] = await count(
      pool,
      'SELECT count(*) FROM docker_stats WHERE host = $1 AND container_id = $2',
      [DOCKER_HOST, containerId]
    );
  }
  snapshot['zfs_stats'] = await count(pool, 'SELECT count(*) FROM zfs_stats WHERE host = $1', [
    ZFS_HOST,
  ]);
  snapshot[`proxmox_stats/${COUNTER_GUEST.entityId}`] = await count(
    pool,
    'SELECT count(*) FROM proxmox_stats WHERE host = $1 AND entity_id = $2',
    [PROXMOX_HOST, COUNTER_GUEST.entityId]
  );
  snapshot['proxmox_stats'] = await count(
    pool,
    'SELECT count(*) FROM proxmox_stats WHERE host = $1',
    [PROXMOX_HOST]
  );
  return snapshot;
}

export function assertRowCountsPreserved(
  before: RowCountSnapshot,
  after: RowCountSnapshot,
  checks: Checks
): void {
  for (const [label, expected] of Object.entries(before)) {
    checks.equal(`rows preserved for ${label}`, after[label], expected);
    checks.equal(`seeded rows are non-empty for ${label}`, expected > 0, true);
  }
}

/**
 * `getContainerInfo` resolves a container's name and image from the newest raw
 * `docker_stats` row, so a container idle past the raw window must not go
 * anonymous.
 */
export async function assertIdleContainerIdentity(pool: Pool, checks: Checks): Promise<void> {
  const row = await selectRow<{
    container_name: string | null;
    image: string | null;
    host: string;
    age_days: number;
  }>(
    pool,
    `SELECT container_name, image, host,
            EXTRACT(EPOCH FROM (now() - time)) / 86400 AS age_days
     FROM docker_stats
     WHERE container_id = $1 AND host = $2
     ORDER BY time DESC
     LIMIT 1`,
    [IDLE_CONTAINER.id, DOCKER_HOST]
  );

  checks.equal('idle container still resolves a name', row?.container_name, IDLE_CONTAINER.name);
  checks.equal('idle container still resolves an image', row?.image, IDLE_CONTAINER.image);
  checks.closeTo(
    'idle container newest row is 31 days old',
    Number(row?.age_days ?? -1),
    IDLE_CONTAINER.newestAgeDays,
    0.25
  );
}

/**
 * The sparse hour holds 59 minutes of 60 samples plus one minute of 12. A
 * sample-count weighted rollup reproduces the raw average exactly; an
 * equal-weighted AVG() of per-minute averages is off by about 1.06 points.
 */
export async function assertWeightedRollup(pool: Pool, checks: Checks): Promise<void> {
  const row = await selectRow<{
    raw_count: string;
    raw_avg: string;
    weighted_avg: string;
    naive_avg: string;
    minute_count: string;
    min_samples: string;
    max_samples: string;
  }>(
    pool,
    `WITH window_bounds AS (
       SELECT date_trunc('hour', min(time)) AS lo
       FROM docker_stats WHERE host = $1 AND container_id = $2
     ),
     rows_in_window AS (
       SELECT time, cpu_percent
       FROM docker_stats, window_bounds
       WHERE host = $1 AND container_id = $2
         AND time >= window_bounds.lo
         AND time < window_bounds.lo + INTERVAL '1 hour'
     ),
     per_minute AS (
       SELECT date_trunc('minute', time) AS bucket,
              avg(cpu_percent) AS avg_cpu,
              count(*) AS sample_count
       FROM rows_in_window
       GROUP BY 1
     )
     SELECT
       (SELECT count(*) FROM rows_in_window) AS raw_count,
       (SELECT avg(cpu_percent) FROM rows_in_window) AS raw_avg,
       (SELECT sum(avg_cpu * sample_count) / sum(sample_count) FROM per_minute) AS weighted_avg,
       (SELECT avg(avg_cpu) FROM per_minute) AS naive_avg,
       (SELECT count(*) FROM per_minute) AS minute_count,
       (SELECT min(sample_count) FROM per_minute) AS min_samples,
       (SELECT max(sample_count) FROM per_minute) AS max_samples`,
    [DOCKER_HOST, SPARSE_HOUR.containerId]
  );

  const expectedRows =
    SPARSE_HOUR.fullMinutes * SPARSE_HOUR.fullSamplesPerMinute + SPARSE_HOUR.shortSamples;
  checks.equal('sparse hour row count', Number(row?.raw_count), expectedRows);
  checks.equal('sparse hour spans 60 minute buckets', Number(row?.minute_count), 60);
  checks.equal('sparse hour has a short bucket', Number(row?.min_samples), SPARSE_HOUR.shortSamples);
  checks.equal(
    'sparse hour has full buckets',
    Number(row?.max_samples),
    SPARSE_HOUR.fullSamplesPerMinute
  );

  const rawAvg = Number(row?.raw_avg);
  const weighted = Number(row?.weighted_avg);
  const naive = Number(row?.naive_avg);

  checks.closeTo('raw average matches the fixture', rawAvg, sparseHourRawAverage(), 1e-9);
  checks.closeTo('weighted rollup equals the raw average', weighted, rawAvg, WEIGHTED_EPSILON);
  checks.closeTo('naive rollup matches the fixture', naive, sparseHourNaiveAverage(), 1e-9);
  checks.differsBy(
    'fixture discriminates weighted from naive rollups',
    naive,
    rawAvg,
    MIN_DISCRIMINATION
  );
}

/**
 * Proxmox reports netin/netout/uptime as cumulative totals with no delta
 * applied downstream, so a bucket must carry its LAST value. The mean of a
 * monotonic counter is the bucket midpoint: plausible-looking and wrong.
 */
export async function assertCumulativeCounters(pool: Pool, checks: Checks): Promise<void> {
  for (const column of ['netin', 'netout', 'uptime']) {
    const violations = await count(
      pool,
      `SELECT count(*) FROM (
         SELECT ${column} AS value,
                lag(${column}) OVER (ORDER BY time) AS previous
         FROM proxmox_stats
         WHERE host = $1 AND entity_id = $2 AND entity_type = $3
       ) ordered
       WHERE previous IS NOT NULL AND value < previous`,
      [PROXMOX_HOST, COUNTER_GUEST.entityId, COUNTER_GUEST.entityType]
    );
    checks.equal(`proxmox_stats.${column} is monotonically increasing`, violations, 0);

    const row = await selectRow<{
      last_value: string;
      avg_value: string;
      max_value: string;
      bucket_samples: string;
    }>(
      pool,
      `WITH bucketed AS (
         SELECT date_trunc('minute', time) AS bucket, time, ${column} AS value
         FROM proxmox_stats
         WHERE host = $1 AND entity_id = $2 AND entity_type = $3
       ),
       newest_bucket AS (SELECT max(bucket) AS bucket FROM bucketed)
       SELECT
         (SELECT value FROM bucketed, newest_bucket
          WHERE bucketed.bucket = newest_bucket.bucket
          ORDER BY time DESC LIMIT 1) AS last_value,
         (SELECT avg(value) FROM bucketed, newest_bucket
          WHERE bucketed.bucket = newest_bucket.bucket) AS avg_value,
         (SELECT max(value) FROM bucketed, newest_bucket
          WHERE bucketed.bucket = newest_bucket.bucket) AS max_value,
         (SELECT count(*) FROM bucketed, newest_bucket
          WHERE bucketed.bucket = newest_bucket.bucket) AS bucket_samples`,
      [PROXMOX_HOST, COUNTER_GUEST.entityId, COUNTER_GUEST.entityType]
    );

    const lastValue = Number(row?.last_value);
    const avgValue = Number(row?.avg_value);
    const maxValue = Number(row?.max_value);
    checks.equal(
      `${column} newest bucket is a whole minute of samples`,
      Number(row?.bucket_samples),
      COUNTER_BUCKET_SAMPLES
    );
    checks.equal(`${column} bucket LAST equals bucket MAX`, lastValue, maxValue);
    checks.differsBy(
      `${column} bucket AVG is not the counter value`,
      avgValue,
      lastValue,
      Math.abs(lastValue) * 1e-6 + 1
    );
  }
}

/**
 * Enforces that the database's continuous aggregates and `AGGREGATE_TIERS` stay
 * in step, then applies the weighted-average and last-value rules to every
 * registered tier.
 */
export async function assertAggregateTiers(pool: Pool, checks: Checks): Promise<void> {
  const views = await selectColumn<string>(
    pool,
    'SELECT view_name FROM timescaledb_information.continuous_aggregates'
  );
  checks.sameSet(
    'continuous aggregates match the tier registry',
    views,
    AGGREGATE_TIERS.map(tier => tier.view)
  );

  for (const tier of AGGREGATE_TIERS) {
    for (const column of tier.weightedAverageColumns) {
      const row = await selectRow<{ tier_value: string; raw_value: string }>(
        pool,
        `WITH bounds AS (
           SELECT date_trunc('hour', min(time)) AS lo
           FROM ${tier.sourceTable} WHERE host = $1 AND container_id = $2
         )
         SELECT
           (SELECT ${column} FROM ${tier.view}, bounds
            WHERE ${tier.timeColumn} = bounds.lo LIMIT 1) AS tier_value,
           (SELECT avg(${column}) FROM ${tier.sourceTable}, bounds
            WHERE host = $1 AND container_id = $2
              AND time >= bounds.lo AND time < bounds.lo + INTERVAL '1 hour') AS raw_value`,
        [DOCKER_HOST, SPARSE_HOUR.containerId]
      );
      checks.closeTo(
        `${tier.view}.${column} is sample-count weighted`,
        Number(row?.tier_value),
        Number(row?.raw_value),
        WEIGHTED_EPSILON
      );
    }

    for (const column of tier.lastValueColumns) {
      const row = await selectRow<{ tier_value: string; raw_last: string }>(
        pool,
        `WITH bounds AS (
           SELECT date_trunc('hour', max(time)) AS lo
           FROM ${tier.sourceTable} WHERE host = $1 AND entity_id = $2
         )
         SELECT
           (SELECT ${column} FROM ${tier.view}, bounds
            WHERE ${tier.timeColumn} = bounds.lo LIMIT 1) AS tier_value,
           (SELECT ${column} FROM ${tier.sourceTable}, bounds
            WHERE host = $1 AND entity_id = $2
              AND time >= bounds.lo AND time < bounds.lo + INTERVAL '1 hour'
            ORDER BY time DESC LIMIT 1) AS raw_last
        `,
        [PROXMOX_HOST, COUNTER_GUEST.entityId]
      );
      checks.equal(
        `${tier.view}.${column} carries the bucket LAST value`,
        Number(row?.tier_value),
        Number(row?.raw_last)
      );
    }
  }
}

async function selectColumn<T>(pool: Pool, sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool.query(sql, params);
  return result.rows.map(row => Object.values(row)[0] as T);
}

async function selectRow<T>(pool: Pool, sql: string, params: unknown[] = []): Promise<T | null> {
  const result = await pool.query(sql, params);
  return (result.rows[0] as T | undefined) ?? null;
}

async function count(pool: Pool, sql: string, params: unknown[] = []): Promise<number> {
  const result = await pool.query(sql, params);
  return Number(Object.values(result.rows[0] ?? {})[0] ?? 0);
}

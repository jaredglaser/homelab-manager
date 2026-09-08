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
  MIN_ROLLUP_DISCRIMINATION,
  NULL_METRIC_HOUR,
  PROXMOX_CLUSTER_ENTITY,
  PROXMOX_HOST,
  PROXMOX_STORAGE_ENTITY,
  REMOVED_COLUMNS,
  SPARSE_HOUR,
  ZFS_ENTITIES,
  ZFS_HOST,
  ZFS_POOL,
  nullMetricDilutedAverage,
  nullMetricRawAverage,
  sparseHourNaiveAverage,
  sparseHourRawAverage,
} from './fixture';

const RELATIVE_EPSILON = 1e-9;
/** uptime is the slowest counter in the fixture; its bucket AVG trails its LAST by ~29.5. */
const COUNTER_AVG_MIN_SEPARATION = 1;

const ROLLUP_SOURCES = ['docker_stats', 'zfs_stats', 'proxmox_stats'];

/**
 * The hour a single-hour docker fixture occupies, read from the rows themselves: an assertion that
 * recomputed `date_trunc('hour', now()) - N hours` would miss the bucket whenever the run crosses
 * an hour boundary after seeding.
 */
const FIXTURE_HOUR_CTE = `bounds AS (
  SELECT date_trunc('hour', min(time)) AS lo
  FROM docker_stats WHERE host = $1 AND container_id = $2
)`;

function toleranceFor(expected: number): number {
  return Math.max(1e-9, Math.abs(expected) * RELATIVE_EPSILON);
}

const EXPECTED_SEGMENTBY: Record<string, string[]> = {
  docker_stats: ['host', 'container_id'],
  zfs_stats: ['host', 'pool', 'entity'],
  proxmox_stats: ['host', 'entity_type', 'entity_id'],
  docker_container_events: ['host', 'container_id'],
};

/**
 * One entity whose buckets get replayed against the tier's source. A tier needs more than one
 * whenever the NULL pattern varies by group key: a proxmox guest carries cpu/mem/disk and a NULL
 * storage_avail, a storage row is the inverse, so neither alone reaches every column.
 */
export interface TierProbe {
  /** Values for the tier's `keyColumns`. */
  key: string[];
  weightedAverageColumns: string[];
  lastValueColumns: string[];
}

/**
 * Registry of continuous-aggregate tiers. `assertAggregateRegistry` enforces that the database's
 * set of continuous aggregates matches this list exactly, `assertTierColumnCoverage` enforces that
 * every column of every tier is claimed by some probe, and `assertAggregateTierValues` replays each
 * tier's aggregation rules against its source.
 */
export interface AggregateTier {
  view: string;
  sourceTable: string;
  /** Doubles as the bucket width and as the boundary that excludes the in-progress bucket. */
  bucketUnit: 'minute' | 'hour';
  /** Weight a source row carries in its bucket: raw rows count once, `_1m` rows carry sample_count. */
  sourceWeight: string;
  /** `_1m` materializes the bucket mean; `_1h` materializes SUM(metric * sample_count) as `<metric>_sum`. */
  weightedColumnShape: 'mean' | 'weighted_sum';
  keyColumns: string[];
  probes: TierProbe[];
}

const DOCKER_TIER_KEYS = ['host', 'container_id'];
const DOCKER_PROBES: TierProbe[] = [
  {
    key: [DOCKER_HOST, SPARSE_HOUR.containerId],
    weightedAverageColumns: [
      'cpu_percent',
      'memory_usage',
      'memory_limit',
      'memory_percent',
      'network_rx_bytes_per_sec',
      'network_tx_bytes_per_sec',
      'block_io_read_bytes_per_sec',
      'block_io_write_bytes_per_sec',
    ],
    lastValueColumns: ['container_name', 'image'],
  },
];

const ZFS_TIER_KEYS = ['host', 'pool', 'entity'];
const ZFS_PROBES: TierProbe[] = [
  {
    key: [ZFS_HOST, ZFS_POOL, ZFS_ENTITIES[0].entity],
    weightedAverageColumns: [
      'capacity_alloc',
      'capacity_free',
      'read_ops_per_sec',
      'write_ops_per_sec',
      'read_bytes_per_sec',
      'write_bytes_per_sec',
      'utilization_percent',
    ],
    lastValueColumns: ['entity_type', 'indent'],
  },
];

const PROXMOX_TIER_KEYS = ['host', 'entity_type', 'entity_id'];
const PROXMOX_PROBES: TierProbe[] = [
  {
    key: [PROXMOX_HOST, COUNTER_GUEST.entityType, COUNTER_GUEST.entityId],
    weightedAverageColumns: ['cpu', 'mem', 'disk'],
    lastValueColumns: [
      'node',
      'entity_name',
      'status',
      'max_cpu',
      'max_mem',
      'max_disk',
      'uptime',
      'vmid',
      'netin',
      'netout',
    ],
  },
  {
    key: [PROXMOX_HOST, PROXMOX_STORAGE_ENTITY.entityType, PROXMOX_STORAGE_ENTITY.entityId],
    weightedAverageColumns: ['storage_avail'],
    lastValueColumns: ['storage_type', 'storage_content', 'storage_shared'],
  },
  {
    key: [PROXMOX_HOST, PROXMOX_CLUSTER_ENTITY.entityType, PROXMOX_CLUSTER_ENTITY.entityId],
    weightedAverageColumns: [],
    lastValueColumns: ['cluster_version'],
  },
];

export const AGGREGATE_TIERS: AggregateTier[] = [
  {
    view: 'docker_stats_1m',
    sourceTable: 'docker_stats',
    bucketUnit: 'minute',
    sourceWeight: '1',
    weightedColumnShape: 'mean',
    keyColumns: DOCKER_TIER_KEYS,
    probes: DOCKER_PROBES,
  },
  {
    view: 'docker_stats_1h',
    sourceTable: 'docker_stats_1m',
    bucketUnit: 'hour',
    sourceWeight: 'sample_count',
    weightedColumnShape: 'weighted_sum',
    keyColumns: DOCKER_TIER_KEYS,
    probes: DOCKER_PROBES,
  },
  {
    view: 'zfs_stats_1m',
    sourceTable: 'zfs_stats',
    bucketUnit: 'minute',
    sourceWeight: '1',
    weightedColumnShape: 'mean',
    keyColumns: ZFS_TIER_KEYS,
    probes: ZFS_PROBES,
  },
  {
    view: 'zfs_stats_1h',
    sourceTable: 'zfs_stats_1m',
    bucketUnit: 'hour',
    sourceWeight: 'sample_count',
    weightedColumnShape: 'weighted_sum',
    keyColumns: ZFS_TIER_KEYS,
    probes: ZFS_PROBES,
  },
  {
    view: 'proxmox_stats_1m',
    sourceTable: 'proxmox_stats',
    bucketUnit: 'minute',
    sourceWeight: '1',
    weightedColumnShape: 'mean',
    keyColumns: PROXMOX_TIER_KEYS,
    probes: PROXMOX_PROBES,
  },
  {
    view: 'proxmox_stats_1h',
    sourceTable: 'proxmox_stats_1m',
    bucketUnit: 'hour',
    sourceWeight: 'sample_count',
    weightedColumnShape: 'weighted_sum',
    keyColumns: PROXMOX_TIER_KEYS,
    probes: PROXMOX_PROBES,
  },
];

function viewColumnFor(tier: AggregateTier, column: string): string {
  return tier.weightedColumnShape === 'weighted_sum' ? `${column}_sum` : column;
}

function probeLabel(probe: TierProbe): string {
  return probe.key[probe.key.length - 1];
}

function keyPredicateFor(tier: AggregateTier): string {
  return tier.keyColumns.map((column, index) => `${column} = $${index + 1}`).join(' AND ');
}

function probeCteFor(tier: AggregateTier): string {
  return `probe AS (
    SELECT max(time) AS bucket FROM ${tier.view}
    WHERE ${keyPredicateFor(tier)} AND time < date_trunc('${tier.bucketUnit}', now())
  )`;
}

export async function assertSchema(pool: Pool, checks: Checks): Promise<void> {
  const tables = await selectColumn<string>(
    pool,
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
  );
  checks.sameSet('public tables match the expected set exactly', tables, EXPECTED_TABLES);

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
  const dockerContainers = [
    ACTIVE_CONTAINER.id,
    IDLE_CONTAINER.id,
    SPARSE_HOUR.containerId,
    NULL_METRIC_HOUR.containerId,
  ];
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
 * Docker history reads resolve identity with `last(container_name, time)` over
 * whichever tier `resolveStatsTier` picks, and the retention cascade carries both
 * identity columns into `_1m` and `_1h`. A container that stopped reporting weeks
 * ago must therefore still resolve a name and image, not go anonymous.
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
 * `runStatsRollupBackfill` swallows a per-source failure and only skips that source's retention,
 * so an empty view or a missing policy is how a failed refresh surfaces.
 */
export async function assertRollupBackfill(pool: Pool, checks: Checks): Promise<void> {
  for (const tier of AGGREGATE_TIERS) {
    const rows = await count(pool, `SELECT count(*) FROM ${tier.view}`);
    checks.equal(`${tier.view} was materialized by the backfill`, rows > 0, true);
  }

  await assertBackfillReachedFullHistory(pool, checks);
  await assertNoFailedRetentionJobs(pool, checks);

  const policies = await pool.query<{ target: string; drop_after: string }>(
    `SELECT
       COALESCE(ca.view_name, j.hypertable_name) AS target,
       CASE
         WHEN (j.config->>'drop_after')::interval = INTERVAL '24 hours' THEN '24 hours'
         WHEN (j.config->>'drop_after')::interval = INTERVAL '30 days' THEN '30 days'
         ELSE COALESCE(j.config->>'drop_after', 'unset')
       END AS drop_after
     FROM timescaledb_information.jobs j
     LEFT JOIN timescaledb_information.continuous_aggregates ca
       ON ca.materialization_hypertable_schema = j.hypertable_schema
      AND ca.materialization_hypertable_name = j.hypertable_name
     WHERE j.proc_name = 'policy_retention'`
  );
  const dropAfter = new Map(policies.rows.map(row => [row.target, row.drop_after]));

  for (const source of ROLLUP_SOURCES) {
    checks.equal(
      `${source} raw rows are dropped after 24 hours`,
      dropAfter.get(source) ?? 'none',
      '24 hours'
    );
    checks.equal(
      `${source}_1m rows are dropped after 30 days`,
      dropAfter.get(`${source}_1m`) ?? 'none',
      '30 days'
    );
    checks.equal(`${source}_1h keeps its rows forever`, dropAfter.has(`${source}_1h`), false);
  }
}

/**
 * `refreshWindows` walks the whole history in fixed-size windows, so a bug in its loop bound leaves
 * recent buckets present and old ones missing. The idle container's 96 samples sit 31 days back,
 * past every window but the first. Read from `_1h`, which carries no retention policy: the same
 * buckets in `_1m` are older than the 30-day policy the backfill has just installed, and a
 * scheduler run could drop them mid-assertion.
 */
async function assertBackfillReachedFullHistory(pool: Pool, checks: Checks): Promise<void> {
  const row = await selectRow<{ hourly_samples: string | null; oldest_age_days: string | null }>(
    pool,
    `SELECT
       sum(sample_count) AS hourly_samples,
       EXTRACT(EPOCH FROM (now() - min(time))) / 86400 AS oldest_age_days
     FROM docker_stats_1h WHERE host = $1 AND container_id = $2`,
    [DOCKER_HOST, IDLE_CONTAINER.id]
  );

  checks.equal(
    'the backfill rolled up every idle-container sample from 31 days back',
    Number(row?.hourly_samples),
    IDLE_CONTAINER.samples
  );
  checks.equal(
    'docker_stats_1h reaches past the raw retention window',
    Number(row?.oldest_age_days) > IDLE_CONTAINER.newestAgeDays,
    true
  );
}

/**
 * The verification databases run at `log_min_messages = 'fatal'`, which hides the server-side ERROR
 * a failed background job leaves behind, so the harness has to read the job status itself.
 *
 * Retention only. The runner is short enough on background workers that a refresh or compression
 * policy regularly loses its slot ("out of background workers"), and neither one's run status is
 * load-bearing here: the harness drives every refresh itself through `runStatsRollupBackfill` and
 * checks the resulting numbers directly. Retention is the one policy nothing else re-derives.
 */
async function assertNoFailedRetentionJobs(pool: Pool, checks: Checks): Promise<void> {
  const available = await selectRow<{ present: boolean }>(
    pool,
    `SELECT to_regclass('timescaledb_information.job_stats') IS NOT NULL AS present`
  );
  if (available?.present !== true) {
    checks.record('background job status is readable', false, 'job_stats view is missing');
    return;
  }

  const failed = await selectColumn<string>(
    pool,
    `SELECT j.proc_name || ' on ' || COALESCE(ca.view_name, j.hypertable_name, 'unknown')
     FROM timescaledb_information.job_stats s
     JOIN timescaledb_information.jobs j ON j.job_id = s.job_id
     LEFT JOIN timescaledb_information.continuous_aggregates ca
       ON ca.materialization_hypertable_schema = j.hypertable_schema
      AND ca.materialization_hypertable_name = j.hypertable_name
     WHERE s.last_run_status = 'Failed' AND j.proc_name = 'policy_retention'`
  );
  checks.equal('no retention job has failed', failed.join(', ') || 'none', 'none');
}

/**
 * The sparse hour holds 59 minutes of 60 samples plus one minute of 12, so `docker_stats_1h_avg`
 * lands on the raw average only if the hourly tier weighted each minute by its sample count. An
 * equal-weighted AVG() over the per-minute averages misses it by about 1.06 points.
 */
export async function assertWeightedRollup(pool: Pool, checks: Checks): Promise<void> {
  const expectedRows =
    SPARSE_HOUR.fullMinutes * SPARSE_HOUR.fullSamplesPerMinute + SPARSE_HOUR.shortSamples;
  const params = [DOCKER_HOST, SPARSE_HOUR.containerId];

  const raw = await selectRow<{ raw_count: string; raw_avg: string | null }>(
    pool,
    `WITH ${FIXTURE_HOUR_CTE}
     SELECT count(*) AS raw_count, avg(cpu_percent) AS raw_avg
     FROM docker_stats, bounds
     WHERE host = $1 AND container_id = $2
       AND time >= bounds.lo AND time < bounds.lo + INTERVAL '1 hour'`,
    params
  );
  checks.equal('sparse hour row count', Number(raw?.raw_count), expectedRows);
  checks.closeTo(
    'raw average matches the fixture',
    Number(raw?.raw_avg),
    sparseHourRawAverage(),
    1e-9
  );

  const rolled = await selectRow<{
    hourly_cpu: unknown;
    hourly_samples: string | null;
    minute_buckets: string;
    min_minute_samples: string | null;
    max_minute_samples: string | null;
  }>(
    pool,
    `WITH ${FIXTURE_HOUR_CTE}
     SELECT
       (SELECT cpu_percent FROM docker_stats_1h_avg, bounds
        WHERE host = $1 AND container_id = $2 AND time = bounds.lo) AS hourly_cpu,
       (SELECT sample_count FROM docker_stats_1h_avg, bounds
        WHERE host = $1 AND container_id = $2 AND time = bounds.lo) AS hourly_samples,
       (SELECT count(*) FROM docker_stats_1m
        WHERE host = $1 AND container_id = $2) AS minute_buckets,
       (SELECT min(sample_count) FROM docker_stats_1m
        WHERE host = $1 AND container_id = $2) AS min_minute_samples,
       (SELECT max(sample_count) FROM docker_stats_1m
        WHERE host = $1 AND container_id = $2) AS max_minute_samples`,
    params
  );

  checks.equal(
    'docker_stats_1m holds one bucket per fixture minute',
    Number(rolled?.minute_buckets),
    60
  );
  checks.equal(
    'docker_stats_1m keeps the short minute sample count',
    Number(rolled?.min_minute_samples),
    SPARSE_HOUR.shortSamples
  );
  checks.equal(
    'docker_stats_1m keeps the full minute sample count',
    Number(rolled?.max_minute_samples),
    SPARSE_HOUR.fullSamplesPerMinute
  );
  checks.equal(
    'docker_stats_1h_avg.sample_count totals the raw rows',
    Number(rolled?.hourly_samples),
    expectedRows
  );

  if (rolled?.hourly_cpu == null) {
    checks.record(
      'docker_stats_1h_avg holds the sparse hour bucket',
      false,
      'cpu_percent is NULL or the bucket is missing'
    );
    return;
  }
  const hourlyCpu = Number(rolled.hourly_cpu);
  checks.closeTo(
    'docker_stats_1h_avg.cpu_percent equals the raw average',
    hourlyCpu,
    sparseHourRawAverage(),
    toleranceFor(sparseHourRawAverage())
  );
  checks.differsBy(
    'docker_stats_1h_avg.cpu_percent is not the equal-weighted average of the minute averages',
    hourlyCpu,
    sparseHourNaiveAverage(),
    MIN_ROLLUP_DISCRIMINATION
  );
}

/**
 * Proxmox reports netin/netout/uptime as cumulative totals with no delta applied downstream, so
 * `proxmox_stats_1m` has to carry each bucket's LAST value. The mean of a monotonic counter is the
 * bucket midpoint: plausible-looking and wrong.
 */
export async function assertCumulativeCounters(pool: Pool, checks: Checks): Promise<void> {
  const params = [PROXMOX_HOST, COUNTER_GUEST.entityId, COUNTER_GUEST.entityType];

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
      params
    );
    checks.equal(`proxmox_stats.${column} is monotonically increasing`, violations, 0);

    const row = await selectRow<{
      tier_value: string | null;
      raw_last: string | null;
      raw_avg: string | null;
      bucket_samples: string;
    }>(
      pool,
      `WITH probe AS (
         SELECT max(time) AS bucket FROM proxmox_stats_1m
         WHERE host = $1 AND entity_id = $2 AND entity_type = $3
           AND time < date_trunc('minute', now())
       ),
       raw_bucket AS (
         SELECT time, ${column} AS value
         FROM proxmox_stats, probe
         WHERE host = $1 AND entity_id = $2 AND entity_type = $3
           AND time >= probe.bucket AND time < probe.bucket + INTERVAL '1 minute'
       )
       SELECT
         (SELECT ${column} FROM proxmox_stats_1m, probe
          WHERE host = $1 AND entity_id = $2 AND entity_type = $3
            AND time = probe.bucket) AS tier_value,
         (SELECT value FROM raw_bucket ORDER BY time DESC LIMIT 1) AS raw_last,
         (SELECT avg(value) FROM raw_bucket) AS raw_avg,
         (SELECT count(*) FROM raw_bucket) AS bucket_samples`,
      params
    );

    checks.equal(
      `${column} probe bucket is a whole minute of samples`,
      Number(row?.bucket_samples),
      COUNTER_BUCKET_SAMPLES
    );
    if (row?.tier_value == null || row.raw_last == null || row.raw_avg == null) {
      checks.record(
        `proxmox_stats_1m holds a ${column} bucket to compare`,
        false,
        `tier=${row?.tier_value} raw_last=${row?.raw_last} raw_avg=${row?.raw_avg}`
      );
      continue;
    }

    const rawAvg = Number(row.raw_avg);
    const tierValue = Number(row.tier_value);
    checks.equal(
      `proxmox_stats_1m.${column} carries the bucket LAST value`,
      tierValue,
      Number(row.raw_last)
    );
    checks.differsBy(
      `proxmox_stats_1m.${column} is not the bucket average`,
      tierValue,
      rawAvg,
      COUNTER_AVG_MIN_SEPARATION
    );
  }
}

/**
 * Measures the NULL dilution that migration 030 documents as a known limitation: a metric NULL for
 * only part of an hour is scaled by the populated fraction, while a metric present on every row is
 * unaffected. Kept as a boundary marker, since no collector writes that state.
 */
export async function assertNullMetricDilution(pool: Pool, checks: Checks): Promise<void> {
  const populatedMinutes = NULL_METRIC_HOUR.minutes - NULL_METRIC_HOUR.nullMinutes;
  const row = await selectRow<{
    minute_buckets: string;
    null_minutes: string;
    null_minute_samples: string | null;
    hourly_cpu: string | null;
    hourly_memory: string | null;
    raw_cpu_avg: string | null;
    raw_memory_avg: string | null;
  }>(
    pool,
    `WITH ${FIXTURE_HOUR_CTE}
     SELECT
       (SELECT count(*) FROM docker_stats_1m
        WHERE host = $1 AND container_id = $2) AS minute_buckets,
       (SELECT count(*) FROM docker_stats_1m
        WHERE host = $1 AND container_id = $2 AND cpu_percent IS NULL) AS null_minutes,
       (SELECT sum(sample_count) FROM docker_stats_1m
        WHERE host = $1 AND container_id = $2 AND cpu_percent IS NULL) AS null_minute_samples,
       (SELECT cpu_percent FROM docker_stats_1h_avg, bounds
        WHERE host = $1 AND container_id = $2 AND time = bounds.lo) AS hourly_cpu,
       (SELECT memory_percent FROM docker_stats_1h_avg, bounds
        WHERE host = $1 AND container_id = $2 AND time = bounds.lo) AS hourly_memory,
       (SELECT avg(cpu_percent) FROM docker_stats, bounds
        WHERE host = $1 AND container_id = $2
          AND time >= bounds.lo AND time < bounds.lo + INTERVAL '1 hour') AS raw_cpu_avg,
       (SELECT avg(memory_percent) FROM docker_stats, bounds
        WHERE host = $1 AND container_id = $2
          AND time >= bounds.lo AND time < bounds.lo + INTERVAL '1 hour') AS raw_memory_avg`,
    [DOCKER_HOST, NULL_METRIC_HOUR.containerId]
  );

  checks.equal(
    'null-metric hour spans every fixture minute',
    Number(row?.minute_buckets),
    NULL_METRIC_HOUR.minutes
  );
  checks.equal(
    'docker_stats_1m leaves the unpopulated minutes NULL',
    Number(row?.null_minutes),
    NULL_METRIC_HOUR.nullMinutes
  );
  checks.equal(
    'docker_stats_1m still counts the samples behind a NULL metric',
    Number(row?.null_minute_samples),
    NULL_METRIC_HOUR.nullMinutes * NULL_METRIC_HOUR.samplesPerMinute
  );
  checks.closeTo(
    'raw average over the populated rows matches the fixture',
    Number(row?.raw_cpu_avg),
    nullMetricRawAverage(),
    1e-9
  );

  if (row?.hourly_cpu == null || row.hourly_memory == null || row.raw_memory_avg == null) {
    checks.record(
      'docker_stats_1h_avg holds the null-metric hour',
      false,
      `cpu=${row?.hourly_cpu} memory=${row?.hourly_memory} raw_memory=${row?.raw_memory_avg}`
    );
    return;
  }

  const hourlyCpu = Number(row.hourly_cpu);
  checks.closeTo(
    `docker_stats_1h_avg.cpu_percent is diluted to ${populatedMinutes}/${NULL_METRIC_HOUR.minutes} of the populated average`,
    hourlyCpu,
    nullMetricDilutedAverage(),
    toleranceFor(nullMetricDilutedAverage())
  );
  checks.differsBy(
    'the diluted hourly average is not the populated average',
    hourlyCpu,
    nullMetricRawAverage(),
    MIN_ROLLUP_DISCRIMINATION
  );

  const rawMemoryAvg = Number(row.raw_memory_avg);
  checks.closeTo(
    'a metric populated on every row is undiluted in the same hour',
    Number(row.hourly_memory),
    rawMemoryAvg,
    toleranceFor(rawMemoryAvg)
  );
}

export async function assertAggregateRegistry(pool: Pool, checks: Checks): Promise<void> {
  const views = await selectColumn<string>(
    pool,
    'SELECT view_name FROM timescaledb_information.continuous_aggregates'
  );
  checks.sameSet(
    'continuous aggregates match the tier registry',
    views,
    AGGREGATE_TIERS.map(tier => tier.view)
  );
}

/**
 * Every column of every tier has to be claimed by some probe. Without this the registry's column
 * lists are a hand-picked subset, and a metric added to an aggregate, renamed, or sourced from the
 * wrong column reaches production with nothing replaying it.
 */
export async function assertTierColumnCoverage(pool: Pool, checks: Checks): Promise<void> {
  for (const tier of AGGREGATE_TIERS) {
    const columns = await selectColumn<string>(
      pool,
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1`,
      [tier.view]
    );

    const claimed = new Set<string>(['time', 'sample_count', ...tier.keyColumns]);
    for (const probe of tier.probes) {
      for (const column of probe.weightedAverageColumns) {
        claimed.add(viewColumnFor(tier, column));
      }
      for (const column of probe.lastValueColumns) {
        claimed.add(column);
      }
    }

    checks.sameSet(`every ${tier.view} column is claimed by a tier probe`, columns, [...claimed]);
  }
}

/**
 * `resolveStatsTier` reads `<source>_1h_avg`, not the hourly aggregate itself, so the division and
 * the `::double precision` cast that view adds sit on the app's hot path. The cast exists to keep
 * `AVG(bigint)`'s numeric off the wire, where node-postgres hands it back as a string, so the type
 * matters as much as the value: `Number()` on both sides would coerce that regression away.
 */
export async function assertHourlyAverageViews(pool: Pool, checks: Checks): Promise<void> {
  for (const tier of AGGREGATE_TIERS) {
    if (tier.weightedColumnShape !== 'weighted_sum') continue;
    const avgView = `${tier.view}_avg`;

    const available = await selectRow<{ present: boolean }>(
      pool,
      'SELECT to_regclass($1::text) IS NOT NULL AS present',
      [avgView]
    );
    checks.equal(`${avgView} exists`, available?.present, true);
    if (available?.present !== true) continue;

    const probeCte = probeCteFor(tier);
    const where = `${keyPredicateFor(tier)} AND time = probe.bucket`;

    for (const probe of tier.probes) {
      for (const column of probe.weightedAverageColumns) {
        const row = await selectRow<{ view_value: unknown; expected: string | null }>(
          pool,
          `WITH ${probeCte}
           SELECT
             (SELECT ${column} FROM ${avgView}, probe WHERE ${where}) AS view_value,
             (SELECT ${column}_sum / NULLIF(sample_count, 0) FROM ${tier.view}, probe
              WHERE ${where}) AS expected`,
          probe.key
        );

        const label = `${avgView}.${column} [${probeLabel(probe)}]`;
        if (row?.view_value == null || row.expected == null) {
          checks.record(
            `${label} and its aggregate expectation are both populated`,
            false,
            `view=${row?.view_value} aggregate=${row?.expected}`
          );
          continue;
        }
        checks.equal(`${label} arrives as a JS number, not numeric text`, typeof row.view_value, 'number');
        const expected = Number(row.expected);
        checks.closeTo(
          `${label} divides the weighted sum by sample_count`,
          Number(row.view_value),
          expected,
          toleranceFor(expected)
        );
      }
    }
  }
}

/**
 * Replays each tier's aggregation rules against its own source for every probe entity: the weighted
 * average or weighted sum, the last-value columns, and the sample_count the hourly tier divides by.
 * The bucket comes from the view itself, excluding the in-progress one, so a tier that materialized
 * nothing fails on a missing bucket rather than comparing NULL against NULL.
 */
export async function assertAggregateTierValues(pool: Pool, checks: Checks): Promise<void> {
  for (const tier of AGGREGATE_TIERS) {
    for (const probe of tier.probes) {
      await assertTierProbe(pool, checks, tier, probe);
    }
  }
}

async function assertTierProbe(
  pool: Pool,
  checks: Checks,
  tier: AggregateTier,
  probe: TierProbe
): Promise<void> {
  const keyPredicate = keyPredicateFor(tier);
  const probeCte = probeCteFor(tier);
  const bucketWidth = `INTERVAL '1 ${tier.bucketUnit}'`;
  const sourceFrom = `${tier.sourceTable}, probe`;
  const sourceWhere = `${keyPredicate} AND time >= probe.bucket AND time < probe.bucket + ${bucketWidth}`;
  const viewFrom = `${tier.view}, probe`;
  const viewWhere = `${keyPredicate} AND time = probe.bucket`;
  const suffix = `[${probeLabel(probe)}]`;

  const found = await selectRow<{ bucket: Date | null }>(
    pool,
    `WITH ${probeCte} SELECT bucket FROM probe`,
    probe.key
  );
  if (found?.bucket == null) {
    checks.record(
      `${tier.view} materialized a closed bucket for ${probeLabel(probe)}`,
      false,
      'the view holds no bucket for the probe entity'
    );
    return;
  }

  const counts = await selectRow<{ view_value: string | null; expected: string | null }>(
    pool,
    `WITH ${probeCte}
     SELECT
       (SELECT sample_count FROM ${viewFrom} WHERE ${viewWhere}) AS view_value,
       (SELECT sum(${tier.sourceWeight}) FROM ${sourceFrom} WHERE ${sourceWhere}) AS expected`,
    probe.key
  );
  if (counts?.view_value == null || counts.expected == null) {
    checks.record(
      `${tier.view}.sample_count ${suffix} and its source total are both populated`,
      false,
      `view=${counts?.view_value} source=${counts?.expected}`
    );
  } else {
    checks.equal(
      `${tier.view}.sample_count ${suffix} totals the source weights`,
      Number(counts.view_value),
      Number(counts.expected)
    );
  }

  const weightedSum = tier.weightedColumnShape === 'weighted_sum';
  for (const column of probe.weightedAverageColumns) {
    const viewColumn = viewColumnFor(tier, column);
    const divisor = weightedSum ? '' : ' / NULLIF(sum(weight), 0)';
    const row = await selectRow<{ view_value: string | null; expected: string | null }>(
      pool,
      `WITH ${probeCte},
       source_rows AS (
         SELECT ${column} AS value, ${tier.sourceWeight} AS weight
         FROM ${sourceFrom} WHERE ${sourceWhere} AND ${column} IS NOT NULL
       )
       SELECT
         (SELECT ${viewColumn} FROM ${viewFrom} WHERE ${viewWhere}) AS view_value,
         (SELECT sum(value * weight)${divisor} FROM source_rows) AS expected`,
      probe.key
    );

    const label = `${tier.view}.${viewColumn} ${suffix}`;
    if (row?.view_value == null || row.expected == null) {
      checks.record(
        `${label} and its source expectation are both populated`,
        false,
        `view=${row?.view_value} source=${row?.expected}`
      );
      continue;
    }
    const expected = Number(row.expected);
    checks.closeTo(
      weightedSum
        ? `${label} is the sample-count weighted sum of its source`
        : `${label} is the bucket mean of its source`,
      Number(row.view_value),
      expected,
      toleranceFor(expected)
    );
  }

  for (const column of probe.lastValueColumns) {
    const row = await selectRow<{ view_value: string | null; expected: string | null }>(
      pool,
      `WITH ${probeCte}
       SELECT
         (SELECT ${column}::text FROM ${viewFrom} WHERE ${viewWhere}) AS view_value,
         (SELECT ${column}::text FROM ${sourceFrom} WHERE ${sourceWhere}
          ORDER BY time DESC LIMIT 1) AS expected`,
      probe.key
    );

    const label = `${tier.view}.${column} ${suffix}`;
    if (row?.view_value == null || row.expected == null) {
      checks.record(
        `${label} and its source expectation are both populated`,
        false,
        `view=${row?.view_value} source=${row?.expected}`
      );
      continue;
    }
    checks.equal(`${label} carries the bucket LAST value`, row.view_value, row.expected);
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

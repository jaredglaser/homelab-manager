import type { Pool } from 'pg';
import type { Checks } from './checks';
import { HOST_PROBE_FAILURE_CODES, MAX_FAILURE_DETAIL_LENGTH } from '@/lib/errors/host-failure-copy';
import { HostRepository } from '@/lib/database/repositories/host-repository';
import { DeployRepository } from '@/lib/database/repositories/deploy-repository';
import { ProxmoxStateRepository } from '@/lib/database/repositories/proxmox-state-repository';
import {
  ACTIVE_CONTAINER,
  TLS_HOST,
  TLS_CERT,
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
  RATE_COLUMNS,
  RATE_GUEST,
  rateCountColumn,
  COMPRESSED_PROXMOX,
  PROXMOX_STATE_PROBE_ID,
  REMOVED_COLUMNS,
  SPARSE_HOUR,
  ZFS_ENTITIES,
  ZFS_HOST,
  ZFS_POOL,
  nullMetricDilutedAverage,
  nullMetricRawAverage,
  sparseHourNaiveAverage,
  sparseHourRawAverage,
  BACKFILL_SENTINEL,
  LEGACY_RESTART_DEPLOY,
  NULL_INVARIANT_ROWS,
  UNIFY_COMPOSE,
  UNIFY_DESTROYED,
  UNIFY_ORPHAN,
  UNIFY_PLAIN,
  UNIFY_REPLICA,
} from './fixture';

const FAILURE_CHECK_VIOLATION = '23514';

async function assertManagedHostFailureCheck(pool: Pool, checks: Checks): Promise<void> {
  const client = await pool.connect();
  const accepts = async (status: string, code: string | null, detail: string | null): Promise<boolean> => {
    await client.query('SAVEPOINT failure_attempt');
    try {
      await client.query(
        `UPDATE managed_hosts SET status = $2, failure_code = $3, failure_detail = $4 WHERE name = $1`,
        ['failure-check-host', status, code, detail]
      );
      return true;
    } catch (err) {
      if ((err as { code?: string }).code !== FAILURE_CHECK_VIOLATION) throw err;
      return false;
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT failure_attempt');
    }
  };

  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO managed_hosts (name, agent_url) VALUES ('failure-check-host', 'http://localhost:9090')`);
    for (const code of HOST_PROBE_FAILURE_CODES) {
      checks.equal(`managed_hosts accepts the ${code} failure code on an unhealthy row`, await accepts('unhealthy', code, 'detail'), true);
    }
    checks.equal('managed_hosts accepts a pending row carrying a cause', await accepts('pending', 'awaiting-enrollment', 'detail'), true);
    checks.equal('managed_hosts accepts a healthy row with no cause', await accepts('healthy', null, null), true);
    checks.equal('managed_hosts rejects a failure code outside the probe set', await accepts('unhealthy', 'bogus', null), false);
    checks.equal('managed_hosts rejects a failure detail with no code', await accepts('unhealthy', null, 'detail'), false);
    checks.equal('managed_hosts rejects a healthy row carrying a cause', await accepts('healthy', 'offline', null), false);

    const repo = new HostRepository({ query: (sql: string, params?: unknown[]) => client.query(sql, params) } as unknown as Pool);
    const URL = 'http://localhost:9090';
    const idRow = await client.query(`SELECT id FROM managed_hosts WHERE name = 'failure-check-host'`);
    const id = Number((idRow.rows[0] as { id: number }).id);
    const stateAfter = async (setup: string, write: () => Promise<void>): Promise<string> => {
      await client.query('SAVEPOINT write_attempt');
      try {
        await client.query(setup);
        await write();
        const row = (await client.query(
          `SELECT status, failure_code, char_length(failure_detail) AS detail_length FROM managed_hosts WHERE id = ${id}`
        )).rows[0] as { status: string; failure_code: string | null; detail_length: number | null };
        return `${row.status}/${row.failure_code ?? '-'}/${row.detail_length ?? '-'}`;
      } finally {
        await client.query('ROLLBACK TO SAVEPOINT write_attempt');
      }
    };
    const pendingFailure = { status: 'pending', failure: { code: 'offline', detail: null } } as const;
    checks.equal(
      'a pending verdict does not land on a row a concurrent check already verified',
      await stateAfter(`UPDATE managed_hosts SET status = 'healthy' WHERE id = ${id}`, () => repo.updateHealth(id, pendingFailure, URL)),
      'healthy/-/-'
    );
    checks.equal(
      'a pending verdict lands on a row that is still pending',
      await stateAfter(`UPDATE managed_hosts SET status = 'pending' WHERE id = ${id}`, () => repo.updateHealth(id, pendingFailure, URL)),
      'pending/offline/-'
    );
    checks.equal(
      'a healthy verdict verifies a pending row',
      await stateAfter(`UPDATE managed_hosts SET status = 'pending' WHERE id = ${id}`, () => repo.updateHealth(id, { status: 'healthy', failure: null }, URL)),
      'healthy/-/-'
    );
    checks.equal(
      'a verdict probed at an old URL does not land after the URL changed',
      await stateAfter(`UPDATE managed_hosts SET status = 'healthy' WHERE id = ${id}`, () =>
        repo.updateHealth(id, { status: 'unhealthy', failure: { code: 'offline', detail: null } }, 'http://old:9090')),
      'healthy/-/-'
    );
    checks.equal(
      'a failure detail is stored cut to the limit',
      await stateAfter(`UPDATE managed_hosts SET status = 'healthy' WHERE id = ${id}`, () =>
        repo.updateHealth(id, { status: 'unhealthy', failure: { code: 'offline', detail: 'x'.repeat(MAX_FAILURE_DETAIL_LENGTH + 80) } }, URL)),
      `unhealthy/offline/${MAX_FAILURE_DETAIL_LENGTH}`
    );
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

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
  /**
   * The tier column counting the rows that carry this probe's weighted columns, when those columns
   * can be NULL on rows that still count in `sample_count`. The hourly tier weights by it instead.
   */
  weightColumn?: string;
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
  ...RATE_COLUMNS.map((column): TierProbe => ({
    key: [RATE_GUEST.host, RATE_GUEST.entityType, RATE_GUEST.entityId],
    weightedAverageColumns: [column],
    lastValueColumns: [],
    weightColumn: rateCountColumn(column),
  })),
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

/** What one source row weighs for this probe: raw rows count once, `_1m` rows carry the probe's count. */
function probeSourceWeight(tier: AggregateTier, probe: TierProbe): string {
  return tier.sourceWeight === '1' ? '1' : (probe.weightColumn ?? tier.sourceWeight);
}

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

  const imageUpdateCheckColumns = new Set(
    await selectColumn<string>(
      pool,
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'image_update_checks'`
    )
  );
  checks.sameSet(
    'image_update_checks carries the persisted update state columns',
    [...imageUpdateCheckColumns],
    ['host', 'stack', 'image', 'current_tag', 'latest_matching_tag', 'latest_overall_tag', 'update_available', 'source_repo', 'error', 'last_error_at', 'etag', 'manifest_digest', 'checked_at']
  );

  const imageUpdateCheckPk = await selectRow<{ definition: string }>(
    pool,
    `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
     WHERE conrelid = 'image_update_checks'::regclass AND contype = 'p'`
  );
  checks.equal(
    'image_update_checks PK is (host, stack, image)',
    imageUpdateCheckPk?.definition.includes('(host, stack, image)'),
    true
  );

  const managedHostFailureColumns = new Set(
    await selectColumn<string>(
      pool,
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'managed_hosts'
         AND column_name IN ('failure_code', 'failure_detail')`
    )
  );
  checks.sameSet(
    'managed_hosts carries the probe failure columns',
    [...managedHostFailureColumns],
    ['failure_code', 'failure_detail']
  );

  await assertManagedHostFailureCheck(pool, checks);

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
  snapshot['proxmox_stats/compressed'] = await count(
    pool,
    'SELECT count(*) FROM proxmox_stats WHERE host = $1',
    [COMPRESSED_PROXMOX.host]
  );
  snapshot['managed_hosts'] = await count(pool, 'SELECT count(*) FROM managed_hosts');
  snapshot['entity_metadata'] = await count(pool, 'SELECT count(*) FROM entity_metadata WHERE value IS NOT NULL');
  const nullStatusHosts = await count(pool, 'SELECT count(*) FROM managed_hosts WHERE name = $1', [
    NULL_INVARIANT_ROWS.host,
  ]);
  if (nullStatusHosts > 0) snapshot[NULL_INVARIANT_ROWS.countLabel] = nullStatusHosts;
  const legacyRestarts = await count(pool, 'SELECT count(*) FROM deploy_history WHERE stack = $1', [
    LEGACY_RESTART_DEPLOY.stack,
  ]);
  if (legacyRestarts > 0) snapshot[LEGACY_RESTART_DEPLOY.countLabel] = legacyRestarts;
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
      if (probe.weightColumn) claimed.add(probe.weightColumn);
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
             (SELECT ${column}_sum / NULLIF(${probe.weightColumn ?? 'sample_count'}, 0) FROM ${tier.view}, probe
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
          `${label} divides the weighted sum by ${probe.weightColumn ?? 'sample_count'}`,
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

  if (probe.weightColumn && probe.weightedAverageColumns.length > 0) {
    const carrier = probe.weightedAverageColumns[0];
    const rowFilter = tier.sourceWeight === '1' ? ` AND ${carrier} IS NOT NULL` : '';
    const weights = await selectRow<{ view_value: string | null; expected: string | null }>(
      pool,
      `WITH ${probeCte}
       SELECT
         (SELECT ${probe.weightColumn} FROM ${viewFrom} WHERE ${viewWhere}) AS view_value,
         (SELECT sum(${probeSourceWeight(tier, probe)}) FROM ${sourceFrom} WHERE ${sourceWhere}${rowFilter}) AS expected`,
      probe.key
    );
    checks.equal(
      `${tier.view}.${probe.weightColumn} ${suffix} counts the source rows that carry a value`,
      Number(weights?.view_value),
      Number(weights?.expected)
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
         SELECT ${column} AS value, ${probeSourceWeight(tier, probe)} AS weight
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

interface BackfillPopulationRow {
  host: string;
  container_id: string;
  container_name: string;
  image: string;
}

/**
 * The migration's own source query: every latest-name container identity in the
 * two aggregate tiers. Asserting against this population rather than a hardcoded
 * container list keeps the check valid as fixtures gain containers.
 */
const BACKFILL_POPULATION_SQL = `
  SELECT DISTINCT ON (host, container_id)
    host, container_id, container_name, image
  FROM (
    SELECT host, container_id, container_name, image, time FROM docker_stats_1m
    UNION ALL
    SELECT host, container_id, container_name, image, time FROM docker_stats_1h_avg
  ) u
  WHERE container_name IS NOT NULL
  ORDER BY host, container_id, time DESC`;

/**
 * Migration 037 applies before seed() in any upgrade whose merge base already
 * contains it, so the explicit rerun here is the only path that exercises the
 * backfill against seeded data. The rerun is safe to repeat because the
 * statement is ON CONFLICT DO NOTHING.
 */
export async function assertServiceKeyBackfill(
  pool: Pool,
  checks: Checks,
  backfillSql: string
): Promise<void> {
  const entities = (
    (await pool.query(BACKFILL_POPULATION_SQL)).rows as BackfillPopulationRow[]
  ).map(r => `${r.host}/${r.container_id}`);
  checks.equal('backfill population is non-empty', entities.length > 0, true);

  const preExisting = new Map<string, string>();
  for (const row of (await pool.query(
    `SELECT entity, key, value FROM entity_metadata
     WHERE source = 'docker' AND key IN ('name', 'image', 'service_key')
       AND entity = ANY($1)`,
    [entities]
  )).rows as { entity: string; key: string; value: string }[]) {
    preExisting.set(`${row.entity}|${row.key}`, row.value);
  }
  checks.equal(
    'the live-written sentinel rows pre-exist, so the clobber path is exercised',
    ['service_key', 'name'].every(
      key => preExisting.get(`${BACKFILL_SENTINEL.entity}|${key}`) !== undefined
    ),
    true
  );

  await pool.query(backfillSql);

  const registered = await pool.query(
    `SELECT entity, key, value FROM entity_metadata
     WHERE source = 'docker' AND key IN ('name', 'image', 'service_key')
       AND entity = ANY($1)`,
    [entities]
  );
  checks.equal(
    'backfill registered name, image and service_key for every stats container',
    registered.rows.length,
    entities.length * 3
  );

  const population = new Map(
    ((await pool.query(BACKFILL_POPULATION_SQL)).rows as BackfillPopulationRow[])
      .map(r => [`${r.host}/${r.container_id}`, r])
  );
  for (const [entity, r] of population) {
    const expected: Record<string, string> = {
      name: preExisting.get(`${entity}|name`) ?? r.container_name,
      image: preExisting.get(`${entity}|image`) ?? r.image,
      service_key: preExisting.get(`${entity}|service_key`) ?? r.container_name,
    };
    const actual = new Map(
      (registered.rows as { entity: string; key: string; value: string }[])
        .filter(row => row.entity === entity)
        .map(row => [row.key, row.value])
    );
    for (const [key, value] of Object.entries(expected)) {
      checks.equal(
        `backfill resolves ${key} for ${entity}`,
        actual.get(key) ?? null,
        value
      );
    }
  }

  const beforeRerun = await count(pool, 'SELECT count(*) FROM entity_metadata');
  await pool.query(backfillSql);
  checks.equal(
    'backfill rerun inserts nothing',
    await count(pool, 'SELECT count(*) FROM entity_metadata'),
    beforeRerun
  );
}

/**
 * Migration 038 rewrites name-based service_key rows to the label-derived key
 * the event table stores. It applies after seed() while it is the head's own
 * new migration, but applies before seed() once it joins the merge base, so the
 * explicit rerun here is the only path that works in both orders.
 */
export async function assertServiceKeyUnification(
  pool: Pool,
  checks: Checks,
  unifySql: string
): Promise<void> {
  await pool.query(unifySql);

  const serviceKeyFor = async (containerId: string): Promise<string | null> => {
    const row = await selectRow<{ value: string }>(
      pool,
      `SELECT value FROM entity_metadata
       WHERE source = 'docker' AND key = 'service_key' AND entity = $1`,
      [`${DOCKER_HOST}/${containerId}`]
    );
    return row?.value ?? null;
  };
  const iconFor = async (entity: string): Promise<string | null> => {
    const row = await selectRow<{ value: string }>(
      pool,
      `SELECT value FROM entity_metadata
       WHERE source = 'docker' AND key = 'icon' AND entity = $1`,
      [entity]
    );
    return row?.value ?? null;
  };

  checks.equal(
    'the compose container rewrites to its latest event key, not the stale one',
    await serviceKeyFor(UNIFY_COMPOSE.containerId),
    UNIFY_COMPOSE.latestEventKey
  );
  checks.equal(
    'the destroy-latest container rewrites to its last upsert key',
    await serviceKeyFor(UNIFY_DESTROYED.containerId),
    UNIFY_DESTROYED.latestUpsertKey
  );
  checks.equal(
    'replica a rewrites to the shared compose key',
    await serviceKeyFor(UNIFY_REPLICA.containerIds[0]),
    UNIFY_REPLICA.eventKey
  );
  checks.equal(
    'replica b rewrites to the shared compose key',
    await serviceKeyFor(UNIFY_REPLICA.containerIds[1]),
    UNIFY_REPLICA.eventKey
  );
  checks.equal(
    'the unlabeled container keeps its already-correct name key',
    await serviceKeyFor(UNIFY_PLAIN.containerId),
    UNIFY_PLAIN.eventKey
  );
  checks.equal(
    'the container with no event row keeps its name key',
    await serviceKeyFor(UNIFY_ORPHAN.containerId),
    UNIFY_ORPHAN.seededNameKey
  );

  const linked = (
    (await pool.query(
      `SELECT SPLIT_PART(sibling.entity, '/', 2) AS container_id
       FROM entity_metadata me
       JOIN entity_metadata sibling
         ON  sibling.source = me.source
         AND sibling.key    = 'service_key'
         AND sibling.value  = me.value
         AND SPLIT_PART(sibling.entity, '/', 1) = $2
       WHERE me.source = 'docker' AND me.entity = $1 AND me.key = 'service_key'`,
      [`${DOCKER_HOST}/${UNIFY_REPLICA.containerIds[0]}`, DOCKER_HOST]
    )).rows as { container_id: string }[]
  ).map(r => r.container_id);
  checks.sameSet(
    'the history fan-out links both replicas through the rewritten key',
    linked,
    UNIFY_REPLICA.containerIds
  );

  checks.equal(
    'an icon pre-existing on the target entity survives the move',
    await iconFor(`${DOCKER_HOST}/${UNIFY_COMPOSE.latestEventKey}`),
    UNIFY_COMPOSE.targetIcon
  );
  checks.equal(
    'the replica icon moves from the old key entity to the new one',
    await iconFor(`${DOCKER_HOST}/${UNIFY_REPLICA.eventKey}`),
    UNIFY_REPLICA.seededIcon
  );
  checks.equal(
    'the unlabeled container keeps its icon',
    await iconFor(`${DOCKER_HOST}/${UNIFY_PLAIN.eventKey}`),
    UNIFY_PLAIN.seededIcon
  );
  checks.equal(
    'the container with no event row keeps its icon',
    await iconFor(`${DOCKER_HOST}/${UNIFY_ORPHAN.seededNameKey}`),
    UNIFY_ORPHAN.seededIcon
  );
  checks.equal(
    'the compose icon copy stays on the old key entity',
    await iconFor(`${DOCKER_HOST}/${UNIFY_COMPOSE.seededNameKey}`),
    UNIFY_COMPOSE.seededOldIcon
  );
  checks.equal(
    'the replica icon copy stays on the old key entity',
    await iconFor(`${DOCKER_HOST}/${UNIFY_REPLICA.names[0]}`),
    UNIFY_REPLICA.seededIcon
  );

  const beforeRerun = await count(pool, 'SELECT count(*) FROM entity_metadata');
  const rerun = await pool.query(unifySql);
  checks.equal(
    'the migration rerun rewrites nothing',
    Number((rerun.rows[0] as { rewrite_count: number }).rewrite_count),
    0
  );
  checks.equal('the migration rerun inserts nothing', await count(pool, 'SELECT count(*) FROM entity_metadata'), beforeRerun);
  checks.equal(
    'the rerun leaves the rewritten key in place',
    await serviceKeyFor(UNIFY_COMPOSE.containerId),
    UNIFY_COMPOSE.latestEventKey
  );
}

export async function assertImageUpdateCheckExpansion(pool: Pool, checks: Checks): Promise<void> {
  const rows = await pool.query(
    `SELECT stack, image, current_tag, latest_matching_tag, update_available, source_repo, etag, manifest_digest, error
     FROM image_update_checks
     ORDER BY stack, image`
  );
  checks.sameSet(
    'image_update_checks rows expanded per running stack with state preserved',
    rows.rows.map((row) =>
      `${row.stack}|${row.image}|${row.current_tag}|${row.latest_matching_tag}|${row.update_available}|${row.source_repo}|${row.etag ?? 'null'}|${row.error ?? 'null'}`
    ),
    [
      // The plex row survived expansion into the media stack with its verdict, etag, and error history intact.
      `media|${UNIFY_COMPOSE.image}|1.0.0|1.0.1|true|example/plex|"etag-plex"|null`,
      // The web row survived expansion into the app stack.
      `app|${UNIFY_REPLICA.image}|2.0.0|null|false|null|null|null`,
    ]
  );

  const digests = await selectColumn<string>(
    pool,
    'SELECT manifest_digest FROM image_update_checks WHERE manifest_digest IS NOT NULL'
  );
  checks.equal('image_update_checks manifest_digest starts null after the expansion', digests.length, 0);

  const orphans = await selectColumn<string>(
    pool,
    `SELECT image FROM image_update_checks WHERE image = 'ghcr.io/example/ghost:9.9.9'`
  );
  checks.equal('image_update_checks rows for images no stack runs were dropped', orphans.length, 0);
}

export async function assertAgentTlsCertificates(pool: Pool, checks: Checks): Promise<void> {
  await pool.query(
    `INSERT INTO managed_hosts (name, agent_url) VALUES ($1, 'http://localhost:9090')
     ON CONFLICT (name) DO NOTHING`,
    [TLS_HOST]
  );
  await pool.query(
    `INSERT INTO agent_tls_certificates (host_name, cert_pem) VALUES ($1, $2)
     ON CONFLICT (host_name) DO NOTHING`,
    [TLS_HOST, TLS_CERT]
  );

  const stored = await selectColumn<string>(
    pool,
    'SELECT cert_pem FROM agent_tls_certificates WHERE host_name = $1',
    [TLS_HOST]
  );
  checks.sameSet('the pinned certificate is stored plaintext', stored, [TLS_CERT]);

  const keyColumns = await selectColumn<string>(
    pool,
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'agent_tls_certificates' AND column_name LIKE '%key%'`
  );
  checks.sameSet('the manager stores no key material', keyColumns, []);

  const rotated = `${TLS_CERT}-rotated`;
  await pool.query(
    `INSERT INTO agent_tls_certificates (host_name, cert_pem) VALUES ($1, $2)
     ON CONFLICT (host_name) DO UPDATE SET cert_pem = EXCLUDED.cert_pem, created_at = now()`,
    [TLS_HOST, rotated]
  );
  checks.equal(
    'rotation replaces the certificate in place instead of adding a row',
    await count(pool, 'SELECT count(*) FROM agent_tls_certificates WHERE host_name = $1', [TLS_HOST]),
    1
  );
  checks.equal(
    'rotation stores the new certificate',
    (await selectColumn<string>(
      pool,
      'SELECT cert_pem FROM agent_tls_certificates WHERE host_name = $1',
      [TLS_HOST]
    ))[0],
    rotated
  );

  await pool.query('UPDATE managed_hosts SET name = $2 WHERE name = $1', [TLS_HOST, `${TLS_HOST}-renamed`]);
  checks.equal(
    'a host rename cascades to the certificate row',
    await count(pool, 'SELECT count(*) FROM agent_tls_certificates WHERE host_name = $1', [`${TLS_HOST}-renamed`]),
    1
  );

  await pool.query('DELETE FROM managed_hosts WHERE name = $1', [`${TLS_HOST}-renamed`]);
  checks.equal(
    'deleting the host deletes its certificate row',
    await count(pool, 'SELECT count(*) FROM agent_tls_certificates'),
    0
  );
}

export async function assertReadInvariantConstraints(pool: Pool, checks: Checks): Promise<void> {
  for (const [table, column] of [['managed_hosts', 'status'], ['entity_metadata', 'value']]) {
    const info = await selectRow<{ is_nullable: string }>(
      pool,
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [table, column]
    );
    checks.equal(`${table}.${column} is NOT NULL`, info?.is_nullable, 'NO');
  }

  const definition = await selectRow<{ definition: string }>(
    pool,
    `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
     WHERE conname = 'deploy_history_action_check' AND conrelid = 'deploy_history'::regclass`
  );
  checks.equal('deploy_history action CHECK no longer allows restart', definition?.definition.includes("'restart'"), false);
  checks.equal('deploy_history action CHECK allows update', definition?.definition.includes("'update'"), true);

  const triggerCheck = await selectRow<{ definition: string }>(
    pool,
    `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
     WHERE conname = 'deploy_history_trigger_check' AND conrelid = 'deploy_history'::regclass`
  );
  checks.equal('deploy_history trigger CHECK lists manual_rollback', triggerCheck?.definition.includes("'manual_rollback'"), true);

  const refusalCode = async (row: { host: string; trigger: string; action: string; postSuccess?: string }): Promise<string | undefined> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO managed_hosts (name, agent_url) VALUES ($1, 'http://localhost:9090')`,
        [row.host]
      );
      await client.query(
        `INSERT INTO deploy_history (stack, host, commit_sha, compose_hash, env_hash, trigger, action, post_success)
         VALUES ('ci-enum-check', $1, 'sha', 'c', 'e', $2, $3, $4)`,
        [row.host, row.trigger, row.action, row.postSuccess ?? null]
      );
      return undefined;
    } catch (err) {
      return (err as { code?: string }).code;
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  };

  checks.equal(
    'the database refuses a restart deploy row',
    await refusalCode({ host: 'ci-action-check', trigger: 'ui', action: 'restart' }),
    '23514'
  );
  checks.equal(
    'the database refuses an unknown deploy trigger',
    await refusalCode({ host: 'ci-trigger-check', trigger: 'cron', action: 'deploy' }),
    '23514'
  );
  checks.equal(
    'the database refuses an unknown post_success hook',
    await refusalCode({ host: 'ci-post-success-check', trigger: 'ui', action: 'deploy', postSuccess: 'notify' }),
    '23514'
  );
}

/** Drives the real repository reads, since the typed read path throws on an action outside DeployAction. */
export async function assertLegacyRestartDeploy(pool: Pool, checks: Checks): Promise<void> {
  const row = await selectRow<{ action: string; status: string }>(
    pool,
    'SELECT action, status FROM deploy_history WHERE stack = $1',
    [LEGACY_RESTART_DEPLOY.stack]
  );
  checks.equal('the legacy restart row is relabeled deploy', row?.action, 'deploy');
  checks.equal('the legacy restart row keeps its status', row?.status, LEGACY_RESTART_DEPLOY.status);

  const repository = new DeployRepository(pool);
  const settle = async <T>(read: () => Promise<T>): Promise<T | string> => {
    try {
      return await read();
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  const latest = await settle(() => repository.getLatestSuccessful(LEGACY_RESTART_DEPLOY.stack, DOCKER_HOST));
  checks.equal(
    'getLatestSuccessful reads the relabeled row',
    typeof latest === 'string' ? latest : latest?.action,
    'deploy'
  );
  const perStack = await settle(() => repository.getLatestDeployPerStack());
  checks.equal(
    'getLatestDeployPerStack reads the relabeled row',
    typeof perStack === 'string' ? perStack : perStack.find(r => r.stack === LEGACY_RESTART_DEPLOY.stack)?.action,
    'deploy'
  );
  const history = await settle(() => repository.getDeployHistory(LEGACY_RESTART_DEPLOY.stack, DOCKER_HOST, 10));
  checks.equal(
    'getDeployHistory reads the relabeled row',
    typeof history === 'string' ? history : history.map(r => r.action).join(','),
    'deploy'
  );
}

export async function assertNullInvariantRepair(pool: Pool, checks: Checks): Promise<void> {
  const host = await selectRow<{ status: string }>(pool, 'SELECT status FROM managed_hosts WHERE name = $1', [
    NULL_INVARIANT_ROWS.host,
  ]);
  checks.equal('a managed host with a NULL status becomes unhealthy', host?.status, 'unhealthy');
  checks.equal(
    'no repaired host is left pending, which would allow plaintext enrollment',
    await count(pool, `SELECT count(*) FROM managed_hosts WHERE name = $1 AND status = 'pending'`, [
      NULL_INVARIANT_ROWS.host,
    ]),
    0
  );
  checks.equal(
    'an entity_metadata row with a NULL value is deleted',
    await count(pool, 'SELECT count(*) FROM entity_metadata WHERE entity = $1', [
      NULL_INVARIANT_ROWS.metadataEntity,
    ]),
    0
  );
}

/**
 * End to end over the cascade: the hourly rate a history read gets from `proxmox_stats_1h_avg`
 * equals the plain mean of the raw rates the live page showed in that hour. Rows with no rate (the
 * first point, a stopped minute) take no part in either side.
 */
export async function assertRateRollupMatchesRaw(pool: Pool, checks: Checks): Promise<void> {
  for (const column of RATE_COLUMNS) {
    const row = await selectRow<{ hourly: number | null; raw: string | null; diluted: string | null }>(
      pool,
      `WITH bucket AS (
         SELECT date_trunc('hour', min(time)) AS lo FROM proxmox_stats
         WHERE host = $1 AND entity_type = $2 AND entity_id = $3
       )
       SELECT
         (SELECT ${column} FROM proxmox_stats_1h_avg, bucket
          WHERE host = $1 AND entity_type = $2 AND entity_id = $3 AND time = bucket.lo) AS hourly,
         (SELECT avg(${column}) FROM proxmox_stats, bucket
          WHERE host = $1 AND entity_type = $2 AND entity_id = $3
            AND time >= bucket.lo AND time < bucket.lo + INTERVAL '1 hour') AS raw,
         (SELECT sum(${column}) / count(*) FROM proxmox_stats, bucket
          WHERE host = $1 AND entity_type = $2 AND entity_id = $3
            AND time >= bucket.lo AND time < bucket.lo + INTERVAL '1 hour') AS diluted`,
      [RATE_GUEST.host, RATE_GUEST.entityType, RATE_GUEST.entityId]
    );
    if (row?.hourly == null || row.raw == null || row.diluted == null) {
      checks.record(`${column} hourly and raw rates are both populated`, false, `hourly=${row?.hourly} raw=${row?.raw}`);
      continue;
    }
    const raw = Number(row.raw);
    checks.closeTo(`proxmox_stats_1h_avg.${column} matches the raw rates the page showed`, Number(row.hourly), raw, toleranceFor(raw));
    checks.equal(
      `the ${column} fixture tells a weighted rate from one diluted by rows with no rate`,
      Math.abs(raw - Number(row.diluted)) > toleranceFor(raw),
      true
    );
  }
}

/**
 * 052 adds columns to proxmox_stats while a chunk of it is compressed. The seeded chunk has to stay
 * compressed and its rows readable through the new columns, which read as NULL.
 */
export async function assertCompressedProxmoxChunk(pool: Pool, checks: Checks): Promise<void> {
  const row = await selectRow<{ compressed_chunks: string; rows_without_rate: string }>(
    pool,
    `SELECT
       (SELECT count(*) FROM timescaledb_information.chunks
        WHERE hypertable_name = 'proxmox_stats' AND is_compressed) AS compressed_chunks,
       (SELECT count(*) FROM proxmox_stats WHERE host = $1 AND net_in_bytes_per_sec IS NULL) AS rows_without_rate`,
    [COMPRESSED_PROXMOX.host]
  );
  checks.equal('a raw proxmox_stats chunk is still compressed after 052', Number(row?.compressed_chunks) > 0, true);
  checks.equal(
    'rows in the compressed chunk read through the new rate columns',
    Number(row?.rows_without_rate),
    COMPRESSED_PROXMOX.samples
  );
}

const NOTIFY_TIMEOUT_MS = 5000;

/** The page learns of a new worker state only through this NOTIFY, so a write that sends none leaves it stale. */
export async function assertProxmoxStateNotify(pool: Pool, checks: Checks): Promise<void> {
  const listener = await pool.connect();
  const payloads: string[] = [];
  let wake: (() => void) | null = null;
  listener.on('notification', (msg) => {
    if (msg.channel !== 'proxmox_state_change') return;
    payloads.push(msg.payload ?? '');
    wake?.();
  });
  const next = (count: number) => new Promise<boolean>((resolve) => {
    if (payloads.length >= count) return resolve(true);
    const timer = setTimeout(() => resolve(false), NOTIFY_TIMEOUT_MS);
    wake = () => {
      if (payloads.length < count) return;
      clearTimeout(timer);
      resolve(true);
    };
  });
  try {
    await listener.query('LISTEN proxmox_state_change');
    await pool.query(
      `INSERT INTO proxmox_collector_state (connection_id, host, port, state)
       VALUES ($1, 'ci-notify.lan', 8006, 'unreachable')`,
      [PROXMOX_STATE_PROBE_ID]
    );
    checks.equal('a proxmox_collector_state insert sends proxmox_state_change', await next(1), true);
    await pool.query("UPDATE proxmox_collector_state SET state = 'collecting' WHERE connection_id = $1", [PROXMOX_STATE_PROBE_ID]);
    checks.equal('a proxmox_collector_state update sends proxmox_state_change', await next(2), true);
    await pool.query('DELETE FROM proxmox_collector_state WHERE connection_id = $1', [PROXMOX_STATE_PROBE_ID]);
    checks.equal('a proxmox_collector_state delete sends proxmox_state_change', await next(3), true);
    checks.sameSet(
      'every proxmox_state_change carries the connection id',
      [...new Set(payloads)],
      [PROXMOX_STATE_PROBE_ID]
    );
  } finally {
    await listener.query('UNLISTEN proxmox_state_change').catch(() => undefined);
    listener.release();
  }
}

/** The page lists saved connections, reading an unreported one as collecting, and a removed one's late state write is cleared. */
export async function assertProxmoxConnections(pool: Pool, checks: Checks): Promise<void> {
  const repo = new ProxmoxStateRepository(pool);
  const ids: number[] = [];
  try {
    for (const address of ['ci-a.lan', 'ci-b.lan']) {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO proxmox_connections (name, address, token_id, token_secret_jwe)
         VALUES ($1, $1, 'root@pam!ci', 'not-a-real-jwe') RETURNING id`,
        [address]
      );
      ids.push(rows[0].id);
    }
    const [reported, unreported] = ids.map(String);
    await repo.record({ connectionId: reported, host: 'ci-a.lan', port: 8006, state: 'token_rejected', reason: 'HTTP 401', lastSuccessAt: null });
    await repo.record({ connectionId: 'ci-removed', host: 'gone.lan', port: 8006, state: 'unreachable', reason: null, lastSuccessAt: null });

    const listed = new Map((await repo.list()).map((c) => [c.connectionId, c]));
    checks.equal('a reported connection lists its recorded state', listed.get(reported)?.state, 'token_rejected');
    checks.equal('an unreported connection lists as collecting', listed.get(unreported)?.state, 'collecting');
    checks.equal('an unreported connection lists its saved address', listed.get(unreported)?.host, 'ci-b.lan');
    checks.equal('a state row without a saved connection is not listed', listed.has('ci-removed'), false);

    await repo.removeOrphans();
    const { rows: left } = await pool.query<{ connection_id: string }>('SELECT connection_id FROM proxmox_collector_state');
    checks.sameSet('removeOrphans keeps only the rows of saved connections', left.map((r) => r.connection_id), [reported]);

    const refused = await pool.query(
      "INSERT INTO proxmox_collector_state (connection_id, host, port, state) VALUES ('ci-off', 'x.lan', 8006, 'collector_off')"
    ).then(() => false, (err: { code?: string }) => err.code === FAILURE_CHECK_VIOLATION);
    checks.equal('proxmox_collector_state refuses the removed collector_off state', refused, true);

    const duplicate = await pool.query(
      "INSERT INTO proxmox_connections (name, address, token_id, token_secret_jwe) VALUES ('dup', 'CI-A.lan', 'root@pam!ci', 'x')"
    ).then(() => false, (err: { code?: string }) => err.code === '23505');
    checks.equal('proxmox_connections refuses a second connection to one address, in any case', duplicate, true);
  } finally {
    await pool.query('DELETE FROM proxmox_collector_state WHERE connection_id = ANY($1::text[])', [[...ids.map(String), 'ci-removed']]);
    await pool.query('DELETE FROM proxmox_connections WHERE id = ANY($1::int[])', [ids]);
  }
}

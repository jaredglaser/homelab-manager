export const DOCKER_HOST = 'ci-docker-a';
export const ZFS_HOST = 'ci-zfs-a';
export const PROXMOX_HOST = 'ci-pve-a';

export const ACTIVE_CONTAINER = {
  id: 'ci-container-active',
  name: 'ci-active-web',
  image: 'ghcr.io/example/web:1.0.0',
  recentSamples: 600,
  decimatedFromMinute: 11,
  decimatedToMinute: 1440,
};

export const IDLE_CONTAINER = {
  id: 'ci-container-idle',
  name: 'ci-idle-batch',
  image: 'ghcr.io/example/batch:2.1.0',
  newestAgeDays: 31,
  samples: 96,
  gapMinutes: 15,
};

/**
 * Minutes 0..58 carry 60 samples at `fullCpuPercent`; minute 59 carries only
 * `shortSamples` at `shortCpuPercent`. Equal-weighted AVG() over per-minute
 * averages yields 11.333 while the true average over raw rows is 10.270, so any
 * rollup that is not sample-count weighted fails the assertion by ~1.06 points.
 */
export const SPARSE_HOUR = {
  containerId: 'ci-container-sparse',
  containerName: 'ci-sparse-agent',
  image: 'ghcr.io/example/agent:0.9.0',
  hoursAgo: 2,
  fullMinutes: 59,
  fullSamplesPerMinute: 60,
  shortMinuteIndex: 59,
  shortSamples: 12,
  fullCpuPercent: 10,
  shortCpuPercent: 90,
};

/**
 * One hour where `cpu_percent` is NULL for `nullMinutes` whole minutes and populated for the
 * rest, with every minute carrying the same sample count. `_1h` sums `metric * sample_count`
 * (NULL minutes contribute nothing) over `SUM(sample_count)` (which still counts them), so the
 * hourly average comes out scaled by the populated fraction. Every other metric stays populated,
 * which keeps the dilution measurable per column instead of per row.
 */
export const NULL_METRIC_HOUR = {
  containerId: 'ci-container-null-metric',
  containerName: 'ci-null-metric-agent',
  image: 'ghcr.io/example/gap:1.2.0',
  hoursAgo: 3,
  minutes: 60,
  samplesPerMinute: 60,
  nullMinutes: 30,
  cpuPercent: 40,
};

export const ZFS_ENTITIES = [
  { entity: 'ci-tank', entityType: 'pool', indent: 0 },
  { entity: 'mirror-0', entityType: 'vdev', indent: 2 },
  { entity: 'sda', entityType: 'disk', indent: 4 },
] as const;

export const ZFS_POOL = 'ci-tank';
export const ZFS_RECENT_SAMPLES = 300;
export const ZFS_DECIMATED_SAMPLES = 288;
export const ZFS_DECIMATED_GAP_MINUTES = 5;

/**
 * netin/netout/uptime arrive from the Proxmox API as cumulative totals and the
 * collector applies no delta, so every aggregate tier must carry the LAST value
 * in a bucket. Averaging returns the bucket midpoint, which looks plausible and
 * is wrong.
 */
export const COUNTER_GUEST = {
  entityType: 'qemu',
  entityId: '100',
  entityName: 'ci-counter-vm',
  node: 'ci-node-1',
  vmid: 100,
  samples: 600,
  netinStart: 1_000_000,
  netinStep: 4096,
  netoutStart: 500_000,
  netoutStep: 2048,
  uptimeStart: 86_400,
  uptimeStep: 1,
};

/** Counter rows are one per second, so a whole minute bucket holds 60 of them. */
export const COUNTER_BUCKET_SAMPLES = Math.min(COUNTER_GUEST.samples, 60);

/**
 * The one entity type whose gauges are NULL and whose storage_* columns are not, which is the
 * NULL pattern migration 032 claims is fixed per entity_type and therefore constant within a
 * rollup group.
 */
export const PROXMOX_STORAGE_ENTITY = {
  entityType: 'storage',
  entityId: 'ci-node-1/local',
  entityName: 'local',
  node: 'ci-node-1',
} as const;

export const PROXMOX_CLUSTER_ENTITY = {
  entityType: 'cluster',
  entityId: 'ci-cluster',
  entityName: 'ci-cluster',
  node: null,
} as const;

export const PROXMOX_STORAGE_VALUES = {
  storageType: 'dir',
  storageContent: 'images,iso',
  storageShared: false,
};

/** `proxmox_stats.cluster_version` is INT, matching the numeric `version` the collector reads. */
export const PROXMOX_CLUSTER_VERSION = 8;

export const PROXMOX_SUPPORTING_ENTITIES = [
  PROXMOX_CLUSTER_ENTITY,
  { entityType: 'node', entityId: 'ci-node-1', entityName: 'ci-node-1', node: 'ci-node-1' },
  { entityType: 'lxc', entityId: '201', entityName: 'ci-lxc', node: 'ci-node-1' },
  PROXMOX_STORAGE_ENTITY,
] as const;

export const PROXMOX_SUPPORTING_SAMPLES = 60;
export const PROXMOX_SUPPORTING_GAP_MINUTES = 1;

export const EXPECTED_TABLES = [
  'agent_keypairs',
  'deploy_history',
  'deploy_queue',
  'docker_container_events',
  'docker_stats',
  'entity_metadata',
  'git_tokens',
  'managed_hosts',
  'migrations',
  'proxmox_stats',
  'sessions',
  'settings',
  'stack_secrets',
  'users',
  'zfs_stats',
];

export const DROPPED_TABLES = ['stack_status'];

export const EXPECTED_HYPERTABLES = [
  'docker_container_events',
  'docker_stats',
  'proxmox_stats',
  'zfs_stats',
];

export const REMOVED_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'docker_stats', column: 'seq' },
  { table: 'zfs_stats', column: 'seq' },
];

export function sparseHourRawAverage(): number {
  const fullRows = SPARSE_HOUR.fullMinutes * SPARSE_HOUR.fullSamplesPerMinute;
  const total =
    fullRows * SPARSE_HOUR.fullCpuPercent + SPARSE_HOUR.shortSamples * SPARSE_HOUR.shortCpuPercent;
  return total / (fullRows + SPARSE_HOUR.shortSamples);
}

export function sparseHourNaiveAverage(): number {
  const total =
    SPARSE_HOUR.fullMinutes * SPARSE_HOUR.fullCpuPercent + SPARSE_HOUR.shortCpuPercent;
  return total / (SPARSE_HOUR.fullMinutes + 1);
}

export function nullMetricRawAverage(): number {
  return NULL_METRIC_HOUR.cpuPercent;
}

export function nullMetricDilutedAverage(): number {
  const populated = NULL_METRIC_HOUR.minutes - NULL_METRIC_HOUR.nullMinutes;
  return (NULL_METRIC_HOUR.cpuPercent * populated) / NULL_METRIC_HOUR.minutes;
}

/** How far apart a correct and an incorrect rollup must land for an assertion to tell them apart. */
export const MIN_ROLLUP_DISCRIMINATION = 0.5;

if (Math.abs(sparseHourNaiveAverage() - sparseHourRawAverage()) < MIN_ROLLUP_DISCRIMINATION) {
  throw new Error(
    `SPARSE_HOUR no longer discriminates weighted from naive rollups: ` +
      `naive ${sparseHourNaiveAverage()} vs raw ${sparseHourRawAverage()}`
  );
}

if (Math.abs(nullMetricDilutedAverage() - nullMetricRawAverage()) < MIN_ROLLUP_DISCRIMINATION) {
  throw new Error(
    `NULL_METRIC_HOUR no longer discriminates a diluted average from an undiluted one: ` +
      `diluted ${nullMetricDilutedAverage()} vs raw ${nullMetricRawAverage()}`
  );
}

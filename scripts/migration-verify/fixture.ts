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

export const PROXMOX_SUPPORTING_ENTITIES = [
  { entityType: 'cluster', entityId: 'ci-cluster', entityName: 'ci-cluster', node: null },
  { entityType: 'node', entityId: 'ci-node-1', entityName: 'ci-node-1', node: 'ci-node-1' },
  { entityType: 'lxc', entityId: '201', entityName: 'ci-lxc', node: 'ci-node-1' },
  { entityType: 'storage', entityId: 'ci-node-1/local', entityName: 'local', node: 'ci-node-1' },
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

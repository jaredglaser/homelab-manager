import type { ZfsDeviceErrors, ZfsGroupKind, ZfsHealthState, ZfsScan } from '@homelab-manager/agent/types/protocol';
import type { ZFSHostHealth, ZFSHostStats, ZFSNodeHealth, ZFSPoolNode, ZFSStatsRow, ZFSTreeNode } from '@/types/zfs';
import type { ZFSTableRow } from '@/components/zfs/ZFSPoolsTable';

export const ZFS_GROUP_LABELS: Readonly<Record<ZfsGroupKind, string>> = {
  special: 'Special devices',
  dedup: 'Dedup devices',
  logs: 'Log devices',
  cache: 'Cache devices',
  spares: 'Spares',
};

export const AGENT_TOO_OLD_FOR_ZFS = "This host's agent is too old to report ZFS stats. Update the agent from the Hosts page.";

/** `unknown` gets no chip: none of the states the page names fits it. */
export const ZFS_STATE_LABELS: Readonly<Record<ZfsHealthState, string | null>> = {
  online: 'Online',
  degraded: 'Degraded',
  faulted: 'Faulted',
  offline: 'Offline',
  unavailable: 'Unavailable',
  removed: 'Removed',
  suspended: 'Suspended',
  unknown: null,
};

export type ZFSHealthTone = 'ok' | 'warning' | 'error';

const STATE_TONES: Readonly<Record<ZfsHealthState, ZFSHealthTone>> = {
  online: 'ok',
  degraded: 'warning',
  offline: 'warning',
  removed: 'warning',
  faulted: 'error',
  unavailable: 'error',
  suspended: 'error',
  unknown: 'ok',
};

export function poolBanner(pool: string, host: string, state: ZfsHealthState): { message: string; tone: ZFSHealthTone } | null {
  if (state === 'degraded') {
    return {
      message: `${pool} on ${host} is degraded. A device has failed or is missing, so the pool has lost redundancy. Your data is still readable.`,
      tone: 'warning',
    };
  }
  if (state === 'faulted' || state === 'suspended' || state === 'unavailable') {
    return { message: `${pool} on ${host} is faulted. Data on this pool may be unavailable.`, tone: 'error' };
  }
  return null;
}

export function deviceErrorsTooltip(errors: ZfsDeviceErrors | null): string | undefined {
  if (!errors || errors.read + errors.write + errors.checksum === 0) return undefined;
  return `${errors.read} read, ${errors.write} write and ${errors.checksum} checksum errors since the counters were last cleared.`;
}

function scanDate(ms: number): string {
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const BINARY_UNITS = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

/** One decimal at most, dropped when it is 0: `0 B`, `1.5 GiB`, `2 TiB`. */
function repaired(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < BINARY_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${Number(value.toFixed(1))} ${BINARY_UNITS[unit]}`;
}

function errorCount(count: number): string {
  return `${count} error${count === 1 ? '' : 's'}`;
}

/** The pool's scrub line. Null for a stopped scan zpool gave no end time for. */
export function scanLine(scan: ZfsScan | null): string | null {
  if (!scan) return 'Never scrubbed';
  const scrub = scan.kind === 'scrub';
  if (scan.state === 'running') return scrub ? `Scrub running, ${scan.percentDone ?? 0}% done` : `Resilvering, ${scan.percentDone ?? 0}% done`;
  if (scan.state === 'paused') return `Scrub paused, ${scan.percentDone ?? 0}% done`;
  if (scan.endedAt === null) return null;
  if (scan.state === 'canceled') return `${scrub ? 'Scrub' : 'Resilver'} canceled ${scanDate(scan.endedAt)}`;
  return `Last ${scrub ? 'scrub' : 'resilver'} ${scanDate(scan.endedAt)}, repaired ${repaired(scan.repairedBytes)}, ${errorCount(scan.errors)}`;
}

function shortTime(ms: number, use12HourTime: boolean): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: use12HourTime });
}

/** Offline wins over unreadable: an offline host sends nothing, so its last report is all there is. */
export function hostHealthNotice(health: ZFSHostHealth | undefined, use12HourTime: boolean): string | undefined {
  if (!health) return undefined;
  if (!health.connected) return `${health.host} is offline. Showing pool health from ${shortTime(health.lastSeenAt, use12HourTime)}.`;
  if (!health.readable) return `Can't read pool health from ${health.host}. I/O stats are still live.`;
  return undefined;
}

export interface ZFSHealthLookup {
  /** By host-prefixed entity, as `ZFSPoolNode.id` and `ZFSTreeNode.id`. */
  node(id: string): ZFSNodeHealth | undefined;
  scan(poolId: string): ZfsScan | null | undefined;
}

export const NO_HEALTH: ZFSHealthLookup = { node: () => undefined, scan: () => undefined };

export function healthLookup(hosts: readonly ZFSHostHealth[]): ZFSHealthLookup {
  const nodes = new Map<string, ZFSNodeHealth>();
  const scans = new Map<string, ZfsScan | null>();
  for (const host of hosts) {
    for (const pool of host.pools) {
      for (const node of pool.nodes) nodes.set(`${host.host}/${node.entity}`, node);
      scans.set(`${host.host}/${pool.nodes[0].entity}`, pool.scan);
    }
  }
  return { node: (id) => nodes.get(id), scan: (id) => scans.get(id) };
}

function stateChip(node: ZFSNodeHealth | undefined, tooltip?: string): ZFSTableRow['health'] {
  const label = node?.state ? ZFS_STATE_LABELS[node.state] : null;
  if (!node?.state || !label) return undefined;
  return { label, tone: STATE_TONES[node.state], tooltip };
}

/**
 * Rows standing in for an offline host whose stats have left the page's window, so its last
 * health keeps showing in the same tree. They carry no capacity and no I/O.
 */
export function offlineHealthRows(hosts: readonly ZFSHostHealth[], hostsWithStats: ReadonlySet<string>): ZFSStatsRow[] {
  return hosts
    .filter((host) => !host.connected && !hostsWithStats.has(host.host))
    .flatMap((host) => host.pools.flatMap((pool) => pool.nodes.map((node): ZFSStatsRow => ({
      time: host.lastSeenAt,
      host: host.host,
      pool: pool.pool,
      entity: node.entity,
      entity_type: node.entityType,
      indent: (node.entity.split('/').length - 1) * 2,
      capacity_alloc: null,
      capacity_free: null,
      read_ops_per_sec: null,
      write_ops_per_sec: null,
      read_bytes_per_sec: null,
      write_bytes_per_sec: null,
      utilization_percent: null,
    }))));
}

function metrics(row: ZFSStatsRow): Pick<ZFSTableRow, 'readOpsPerSec' | 'writeOpsPerSec' | 'readBytesPerSec' | 'writeBytesPerSec' | 'utilizationPercent'> {
  return {
    readOpsPerSec: row.read_ops_per_sec ?? undefined,
    writeOpsPerSec: row.write_ops_per_sec ?? undefined,
    readBytesPerSec: row.read_bytes_per_sec ?? undefined,
    writeBytesPerSec: row.write_bytes_per_sec ?? undefined,
    utilizationPercent: row.utilization_percent ?? undefined,
  };
}

export function buildHostRow(host: ZFSHostStats, totalHosts: number, health: ZFSHealthLookup = NO_HEALTH, healthNotice?: string): ZFSTableRow {
  const a = host.aggregated;
  const totalPools = host.pools.size;
  const children = Array.from(host.pools.values()).map((pool) => buildPoolRow(pool, totalPools, health));

  return {
    type: 'host',
    id: `host:${host.hostName}`,
    name: host.hostName,
    indent: 0,
    capacityAlloc: a.capacityAlloc,
    capacityFree: a.capacityFree,
    readOpsPerSec: a.readOpsPerSec,
    writeOpsPerSec: a.writeOpsPerSec,
    readBytesPerSec: a.readBytesPerSec,
    writeBytesPerSec: a.writeBytesPerSec,
    badge: { label: `${a.poolCount} pool${a.poolCount === 1 ? '' : 's'}` },
    notice: host.agentOutdated ? AGENT_TOO_OLD_FOR_ZFS : undefined,
    healthNotice,
    canExpand: totalHosts > 1 && totalPools > 0,
    totalHosts,
    children,
  };
}

function isSingleDisk(devices: ZFSTreeNode[]): boolean {
  if (devices.length !== 1) return false;
  const [device] = devices;
  return device.type === 'disk' || device.children.length <= 1;
}

/**
 * A pool row with its device rows. A pool with one vdev of several disks shows the disks directly,
 * with the vdev as its badge, to save an expansion step. Device groups always follow as their own rows.
 */
export function buildPoolRow(pool: ZFSPoolNode, totalPools: number, health: ZFSHealthLookup = NO_HEALTH): ZFSTableRow {
  const toDeviceRow = (node: ZFSTreeNode) => buildDeviceRow(node, health);
  const devices = pool.children.filter((child) => child.type !== 'group');
  const groups = pool.children.filter((child) => child.type === 'group');

  let badge: ZFSTableRow['badge'];
  let deviceRows: ZFSTableRow[];
  if (isSingleDisk(devices)) {
    const [device] = devices;
    badge = { label: 'single disk', tooltip: device.children[0]?.name ?? device.name };
    deviceRows = [];
  } else if (devices.length === 1 && devices[0].type === 'vdev') {
    badge = { label: devices[0].name };
    deviceRows = devices[0].children.map(toDeviceRow);
  } else {
    deviceRows = devices.map(toDeviceRow);
  }

  const children = [...deviceRows, ...groups.map(toDeviceRow)];
  const scan = health.scan(pool.id);
  const canExpand = children.length > 0;

  return {
    type: 'pool',
    id: pool.id,
    name: pool.name,
    indent: 0,
    capacityAlloc: pool.row.capacity_alloc ?? undefined,
    capacityFree: pool.row.capacity_free ?? undefined,
    ...metrics(pool.row),
    badge,
    health: stateChip(health.node(pool.id)),
    detail: scan === undefined ? undefined : scanLine(scan) ?? undefined,
    canExpand,
    totalPools,
    children: canExpand ? children : undefined,
  };
}

export function buildDeviceRow(node: ZFSTreeNode, health: ZFSHealthLookup = NO_HEALTH): ZFSTableRow {
  const children = node.children.map((child) => buildDeviceRow(child, health));
  const canExpand = children.length > 0;
  const base = {
    indent: 0,
    canExpand,
    children: canExpand ? children : undefined,
  };

  if (node.type === 'group' && node.group) {
    return { ...base, type: 'group', id: `group:${node.id}`, name: ZFS_GROUP_LABELS[node.group] };
  }

  const nodeHealth = health.node(node.id);
  return {
    ...base,
    health: stateChip(nodeHealth, node.type === 'disk' ? deviceErrorsTooltip(nodeHealth?.errors ?? null) : undefined),
    type: node.type === 'vdev' ? 'vdev' : 'disk',
    id: `${node.type}:${node.id}`,
    name: node.name,
    capacityAlloc: node.row.capacity_alloc ?? undefined,
    capacityFree: node.row.capacity_free ?? undefined,
    ...metrics(node.row),
  };
}

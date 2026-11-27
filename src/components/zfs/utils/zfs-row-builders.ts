import type { ZfsGroupKind } from '@homelab-manager/agent/types/protocol';
import type { ZFSHostStats, ZFSPoolNode, ZFSStatsRow, ZFSTreeNode } from '@/types/zfs';
import type { ZFSTableRow } from '@/components/zfs/ZFSPoolsTable';

export const ZFS_GROUP_LABELS: Readonly<Record<ZfsGroupKind, string>> = {
  special: 'Special devices',
  dedup: 'Dedup devices',
  logs: 'Log devices',
  cache: 'Cache devices',
  spares: 'Spares',
};

export const AGENT_TOO_OLD_FOR_ZFS = "This host's agent is too old to report ZFS stats. Update the agent from the Hosts page.";

function metrics(row: ZFSStatsRow): Pick<ZFSTableRow, 'readOpsPerSec' | 'writeOpsPerSec' | 'readBytesPerSec' | 'writeBytesPerSec' | 'utilizationPercent'> {
  return {
    readOpsPerSec: row.read_ops_per_sec ?? undefined,
    writeOpsPerSec: row.write_ops_per_sec ?? undefined,
    readBytesPerSec: row.read_bytes_per_sec ?? undefined,
    writeBytesPerSec: row.write_bytes_per_sec ?? undefined,
    utilizationPercent: row.utilization_percent ?? undefined,
  };
}

export function buildHostRow(host: ZFSHostStats, totalHosts: number): ZFSTableRow {
  const a = host.aggregated;
  const totalPools = host.pools.size;
  const children = Array.from(host.pools.values()).map((pool) => buildPoolRow(pool, totalPools));

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
export function buildPoolRow(pool: ZFSPoolNode, totalPools: number): ZFSTableRow {
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
    deviceRows = devices[0].children.map(buildDeviceRow);
  } else {
    deviceRows = devices.map(buildDeviceRow);
  }

  const children = [...deviceRows, ...groups.map(buildDeviceRow)];
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
    canExpand,
    totalPools,
    children: canExpand ? children : undefined,
  };
}

export function buildDeviceRow(node: ZFSTreeNode): ZFSTableRow {
  const children = node.children.map(buildDeviceRow);
  const canExpand = children.length > 0;
  const base = {
    indent: 0,
    canExpand,
    children: canExpand ? children : undefined,
  };

  if (node.type === 'group' && node.group) {
    return { ...base, type: 'group', id: `group:${node.id}`, name: ZFS_GROUP_LABELS[node.group] };
  }

  return {
    ...base,
    type: node.type === 'vdev' ? 'vdev' : 'disk',
    id: `${node.type}:${node.id}`,
    name: node.name,
    capacityAlloc: node.row.capacity_alloc ?? undefined,
    capacityFree: node.row.capacity_free ?? undefined,
    ...metrics(node.row),
  };
}

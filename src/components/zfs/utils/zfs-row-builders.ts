import type { ZFSHostStats, PoolStats, VdevStats } from '@/types/zfs';
import type { ZFSTableRow } from '@/components/zfs/ZFSPoolsTable';

export function buildHostRow(host: ZFSHostStats, totalHosts: number): ZFSTableRow {
  const a = host.aggregated;
  const totalPools = host.pools.size;
  const sortedPools = Array.from(host.pools.values()).sort((a, b) =>
    a.data.name.localeCompare(b.data.name),
  );

  const children = sortedPools.map((pool) => buildPoolRow(pool, totalPools));

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
    canExpand: totalHosts > 1 && totalPools > 0,
    totalHosts,
    children,
  };
}

/**
 * Build a pool-level tree row with vdev/disk children.
 * When a pool has exactly one vdev with multiple disks, skips the vdev level and
 * shows disks directly under the pool to avoid a redundant expansion step.
 */
export function buildPoolRow(pool: PoolStats, totalPools: number): ZFSTableRow {
  const vdevs = Array.from(pool.vdevs.values()).sort((a, b) =>
    a.data.name.localeCompare(b.data.name),
  );
  const individualDisks = Array.from(pool.individualDisks.values()).sort((a, b) =>
    a.data.name.localeCompare(b.data.name),
  );

  const singleVdev = vdevs.length === 1 && individualDisks.length === 0;
  const isSingleDiskPool =
    (singleVdev && vdevs[0].disks.size <= 1) ||
    (vdevs.length === 0 && individualDisks.length === 1);
  const isSingleVdevMultiDisk = singleVdev && vdevs[0].disks.size > 1;

  let badge: { label: string; tooltip?: string } | undefined;
  if (isSingleDiskPool) {
    const tooltipName = singleVdev
      ? Array.from(vdevs[0].disks.values())[0]?.data.name ?? vdevs[0].data.name
      : individualDisks[0]?.data.name;
    badge = { label: 'single disk', tooltip: tooltipName };
  } else if (singleVdev) {
    badge = { label: vdevs[0].data.name };
  }

  const expandable = !isSingleDiskPool;
  let children: ZFSTableRow[] | undefined;

  if (expandable) {
    if (isSingleVdevMultiDisk) {
      // Skip the vdev level, show disks directly under pool
      const vdevDisks = Array.from(vdevs[0].disks.values()).sort((a, b) =>
        a.data.name.localeCompare(b.data.name),
      );
      children = vdevDisks.map((disk) => buildDiskRow(disk.data.id, disk.data.name, disk.data, 0));
    } else {
      const vdevChildren = vdevs.map((vdev) => buildVdevRow(vdev));
      const diskChildren = individualDisks.map((disk) =>
        buildDiskRow(disk.data.id, disk.data.name, disk.data, 0),
      );
      children = [...vdevChildren, ...diskChildren];
    }
  }

  return {
    type: 'pool',
    id: pool.data.id,
    name: pool.data.name,
    indent: 0,
    capacityAlloc: pool.data.capacity.alloc,
    capacityFree: pool.data.capacity.free,
    readOpsPerSec: pool.data.rates.readOpsPerSec,
    writeOpsPerSec: pool.data.rates.writeOpsPerSec,
    readBytesPerSec: pool.data.rates.readBytesPerSec,
    writeBytesPerSec: pool.data.rates.writeBytesPerSec,
    utilizationPercent: pool.data.rates.utilizationPercent,
    badge,
    canExpand: expandable,
    totalPools,
    children,
  };
}

export function buildVdevRow(vdev: VdevStats): ZFSTableRow {
  const sortedDisks = Array.from(vdev.disks.values()).sort((a, b) =>
    a.data.name.localeCompare(b.data.name),
  );

  const hasDisks = sortedDisks.length > 0;
  const children = hasDisks
    ? sortedDisks.map((disk) => buildDiskRow(disk.data.id, disk.data.name, disk.data, 0))
    : undefined;

  return {
    type: 'vdev',
    id: `vdev:${vdev.data.id}`,
    name: vdev.data.name,
    indent: 0,
    capacityAlloc: vdev.data.capacity.alloc > 0 ? vdev.data.capacity.alloc : undefined,
    capacityFree: vdev.data.capacity.alloc > 0 ? vdev.data.capacity.free : undefined,
    readOpsPerSec: vdev.data.rates.readOpsPerSec,
    writeOpsPerSec: vdev.data.rates.writeOpsPerSec,
    readBytesPerSec: vdev.data.rates.readBytesPerSec,
    writeBytesPerSec: vdev.data.rates.writeBytesPerSec,
    utilizationPercent: vdev.data.rates.utilizationPercent,
    canExpand: hasDisks,
    children,
  };
}

export function buildDiskRow(
  id: string,
  name: string,
  data: { rates: { readOpsPerSec: number; writeOpsPerSec: number; readBytesPerSec: number; writeBytesPerSec: number; utilizationPercent: number } },
  indent: number,
): ZFSTableRow {
  return {
    type: 'disk',
    id: `disk:${id}`,
    name,
    indent,
    readOpsPerSec: data.rates.readOpsPerSec,
    writeOpsPerSec: data.rates.writeOpsPerSec,
    readBytesPerSec: data.rates.readBytesPerSec,
    writeBytesPerSec: data.rates.writeBytesPerSec,
    utilizationPercent: data.rates.utilizationPercent,
    canExpand: false,
  };
}

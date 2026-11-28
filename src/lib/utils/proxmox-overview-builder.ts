import type {
  ProxmoxClusterOverview,
  ProxmoxGuest,
  ProxmoxNode,
  ProxmoxStorage,
  ProxmoxStatsRow,
} from '@/types/proxmox';

/** Live-stream entity key: the connection's host first, so two clusters that both have a guest 100 never share a key. */
export function proxmoxEntityKey(row: Pick<ProxmoxStatsRow, 'host' | 'entity_type' | 'entity_id'>): string {
  return `${row.host}/${row.entity_type}/${row.entity_id}`;
}

function toGuest(r: ProxmoxStatsRow): ProxmoxGuest {
  return {
    host: r.host,
    node: r.node ?? '',
    vmid: r.vmid ?? 0,
    name: r.entity_name ?? '',
    status: r.status ?? 'stopped',
    cpu: r.cpu ?? 0,
    cpus: r.max_cpu ?? 0,
    mem: Number(r.mem ?? 0),
    maxmem: Number(r.max_mem ?? 0),
    disk: Number(r.disk ?? 0),
    maxdisk: Number(r.max_disk ?? 0),
    uptime: Number(r.uptime ?? 0),
    netInBytesPerSec: r.net_in_bytes_per_sec,
    netOutBytesPerSec: r.net_out_bytes_per_sec,
    diskReadBytesPerSec: r.disk_read_bytes_per_sec,
    diskWriteBytesPerSec: r.disk_write_bytes_per_sec,
  };
}

/**
 * Builds a ProxmoxClusterOverview from the latest ProxmoxStatsRow entries keyed by entity.
 *
 * @param latestByEntity - Map of the most-recent `ProxmoxStatsRow` for each entity identifier
 * @returns The reconstructed `ProxmoxClusterOverview`, or `null` if neither a cluster row nor any node rows are present
 */
export function buildProxmoxOverview(
  latestByEntity: Map<string, ProxmoxStatsRow>,
): ProxmoxClusterOverview | null {
  let clusterRow: ProxmoxStatsRow | null = null;
  const nodeRows: ProxmoxStatsRow[] = [];
  const vmRows: ProxmoxStatsRow[] = [];
  const containerRows: ProxmoxStatsRow[] = [];
  const storageRows: ProxmoxStatsRow[] = [];

  for (const row of latestByEntity.values()) {
    switch (row.entity_type) {
      case 'cluster':
        if (!clusterRow || row.host < clusterRow.host) clusterRow = row;
        break;
      case 'node':
        nodeRows.push(row);
        break;
      case 'qemu':
        vmRows.push(row);
        break;
      case 'lxc':
        containerRows.push(row);
        break;
      case 'storage':
        storageRows.push(row);
        break;
    }
  }

  if (!clusterRow && nodeRows.length === 0) return null;

  const clusterName = clusterRow?.entity_name ?? 'Standalone';
  const quorate = clusterRow?.status === 'quorate';
  const version = clusterRow?.cluster_version ?? 0;

  const nodes: ProxmoxNode[] = nodeRows.map((r) => ({
    host: r.host,
    node: r.entity_id,
    status: (r.status ?? 'unknown') as ProxmoxNode['status'],
    cpu: r.max_cpu ? (r.cpu ?? 0) / r.max_cpu : 0,
    maxcpu: r.max_cpu ?? 0,
    mem: Number(r.mem ?? 0),
    maxmem: Number(r.max_mem ?? 0),
    disk: Number(r.disk ?? 0),
    maxdisk: Number(r.max_disk ?? 0),
    uptime: Number(r.uptime ?? 0),
  }));

  const vms = vmRows.map(toGuest);
  const containers = containerRows.map(toGuest);

  // Reconstruct storages
  const storages: ProxmoxStorage[] = storageRows.map((r) => ({
    host: r.host,
    storage: r.entity_name ?? '',
    type: r.storage_type ?? '',
    content: r.storage_content ?? '',
    active: r.status === 'active' ? 1 : 0,
    enabled: 1,
    shared: r.storage_shared ? 1 : 0,
    used: Number(r.disk ?? 0),
    avail: Number(r.storage_avail ?? 0),
    total: Number(r.max_disk ?? 0),
    used_fraction: r.max_disk ? Number(r.disk ?? 0) / Number(r.max_disk) : 0,
    node: r.node ?? '',
  }));

  // Compute totals from node rows (matching the cluster row math in snapshotToRows)
  const totalCpu = nodes.reduce((sum, n) => sum + n.maxcpu, 0);
  const usedCpu = nodes.reduce((sum, n) => sum + n.cpu * n.maxcpu, 0);
  const totalMemory = nodes.reduce((sum, n) => sum + n.maxmem, 0);
  const usedMemory = nodes.reduce((sum, n) => sum + n.mem, 0);
  const totalDisk = nodes.reduce((sum, n) => sum + n.maxdisk, 0);
  const usedDisk = nodes.reduce((sum, n) => sum + n.disk, 0);

  const runningVMs = vms.filter((vm) => vm.status === 'running').length;
  const stoppedVMs = vms.filter((vm) => vm.status !== 'running').length;
  const runningContainers = containers.filter((ct) => ct.status === 'running').length;
  const stoppedContainers = containers.filter((ct) => ct.status !== 'running').length;

  return {
    clusterName,
    quorate,
    version,
    nodes,
    vms,
    containers,
    storages,
    totals: {
      totalCpu,
      usedCpu,
      totalMemory,
      usedMemory,
      totalDisk,
      usedDisk,
      runningVMs,
      stoppedVMs,
      runningContainers,
      stoppedContainers,
    },
  };
}

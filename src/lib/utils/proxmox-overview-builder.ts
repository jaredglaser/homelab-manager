import type {
  ProxmoxClusterOverview,
  ProxmoxNode,
  ProxmoxVM,
  ProxmoxContainer,
  ProxmoxStorage,
  ProxmoxStatsRow,
} from '@/types/proxmox';

/**
 * Reconstruct a ProxmoxClusterOverview from the latest row per entity.
 * This is the inverse of `overviewToRows()` — it takes the flat DB rows
 * and rebuilds the nested overview structure that downstream UI components expect.
 *
 * Totals are computed from node rows (matching the logic in ProxmoxClient.getClusterOverview).
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
        clusterRow = row;
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

  // Reconstruct node objects
  const nodes: ProxmoxNode[] = nodeRows.map((r) => ({
    node: r.entity_id,
    status: (r.status ?? 'unknown') as 'online' | 'offline' | 'unknown',
    cpu: r.max_cpu ? (r.cpu ?? 0) / r.max_cpu : 0,
    maxcpu: r.max_cpu ?? 0,
    mem: Number(r.mem ?? 0),
    maxmem: Number(r.max_mem ?? 0),
    disk: Number(r.disk ?? 0),
    maxdisk: Number(r.max_disk ?? 0),
    uptime: Number(r.uptime ?? 0),
    type: 'node',
    id: `node/${r.entity_id}`,
  }));

  // Reconstruct VMs
  const vms: (ProxmoxVM & { node: string })[] = vmRows.map((r) => ({
    vmid: r.vmid ?? 0,
    name: r.entity_name ?? '',
    status: (r.status ?? 'stopped') as 'running' | 'stopped' | 'paused' | 'suspended',
    cpu: r.cpu ?? 0,
    cpus: r.max_cpu ?? 0,
    mem: Number(r.mem ?? 0),
    maxmem: Number(r.max_mem ?? 0),
    disk: Number(r.disk ?? 0),
    maxdisk: Number(r.max_disk ?? 0),
    uptime: Number(r.uptime ?? 0),
    netin: Number(r.netin ?? 0),
    netout: Number(r.netout ?? 0),
    diskread: 0,
    diskwrite: 0,
    node: r.node ?? '',
  }));

  // Reconstruct containers
  const containers: (ProxmoxContainer & { node: string })[] = containerRows.map((r) => ({
    vmid: r.vmid ?? 0,
    name: r.entity_name ?? '',
    status: (r.status ?? 'stopped') as 'running' | 'stopped',
    type: 'lxc',
    cpu: r.cpu ?? 0,
    cpus: r.max_cpu ?? 0,
    mem: Number(r.mem ?? 0),
    maxmem: Number(r.max_mem ?? 0),
    disk: Number(r.disk ?? 0),
    maxdisk: Number(r.max_disk ?? 0),
    uptime: Number(r.uptime ?? 0),
    netin: Number(r.netin ?? 0),
    netout: Number(r.netout ?? 0),
    diskread: 0,
    diskwrite: 0,
    swap: 0,
    maxswap: 0,
    node: r.node ?? '',
  }));

  // Reconstruct storages
  const storages: (ProxmoxStorage & { node: string })[] = storageRows.map((r) => ({
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

  // Compute totals from node rows (matching ProxmoxClient.getClusterOverview logic)
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

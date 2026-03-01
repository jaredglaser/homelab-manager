import type { ProxmoxClusterOverview, ProxmoxStatsRow } from '@/types/proxmox';

/**
 * Convert a ProxmoxClusterOverview (from the Proxmox REST API) into flat
 * ProxmoxStatsRow[] suitable for insertion into the proxmox_stats hypertable.
 *
 * Produces one row per entity: 1 cluster + N nodes + M guests + K storages.
 */
export function overviewToRows(
  overview: ProxmoxClusterOverview,
  host: string,
): ProxmoxStatsRow[] {
  const now = new Date();
  const rows: ProxmoxStatsRow[] = [];

  // Cluster-level row
  rows.push({
    time: now,
    host,
    entity_type: 'cluster',
    node: null,
    entity_id: overview.clusterName,
    entity_name: overview.clusterName,
    status: overview.quorate ? 'quorate' : 'no-quorum',
    cpu: overview.totals.usedCpu,
    max_cpu: overview.totals.totalCpu,
    mem: overview.totals.usedMemory,
    max_mem: overview.totals.totalMemory,
    disk: overview.totals.usedDisk,
    max_disk: overview.totals.totalDisk,
    uptime: null,
    vmid: null,
    netin: null,
    netout: null,
    storage_type: null,
    storage_content: null,
    storage_avail: null,
    storage_shared: null,
    cluster_version: overview.version,
  });

  // Node rows
  for (const node of overview.nodes) {
    rows.push({
      time: now,
      host,
      entity_type: 'node',
      node: node.node,
      entity_id: node.node,
      entity_name: node.node,
      status: node.status,
      cpu: node.cpu * node.maxcpu,
      max_cpu: node.maxcpu,
      mem: node.mem,
      max_mem: node.maxmem,
      disk: node.disk,
      max_disk: node.maxdisk,
      uptime: node.uptime,
      vmid: null,
      netin: null,
      netout: null,
      storage_type: null,
      storage_content: null,
      storage_avail: null,
      storage_shared: null,
      cluster_version: null,
    });
  }

  // VM rows
  for (const vm of overview.vms) {
    rows.push({
      time: now,
      host,
      entity_type: 'qemu',
      node: vm.node,
      entity_id: String(vm.vmid),
      entity_name: vm.name,
      status: vm.status,
      cpu: vm.cpu,
      max_cpu: vm.cpus,
      mem: vm.mem,
      max_mem: vm.maxmem,
      disk: vm.disk,
      max_disk: vm.maxdisk,
      uptime: vm.uptime,
      vmid: vm.vmid,
      netin: vm.netin,
      netout: vm.netout,
      storage_type: null,
      storage_content: null,
      storage_avail: null,
      storage_shared: null,
      cluster_version: null,
    });
  }

  // Container rows
  for (const ct of overview.containers) {
    rows.push({
      time: now,
      host,
      entity_type: 'lxc',
      node: ct.node,
      entity_id: String(ct.vmid),
      entity_name: ct.name,
      status: ct.status,
      cpu: ct.cpu,
      max_cpu: ct.cpus,
      mem: ct.mem,
      max_mem: ct.maxmem,
      disk: ct.disk,
      max_disk: ct.maxdisk,
      uptime: ct.uptime,
      vmid: ct.vmid,
      netin: ct.netin,
      netout: ct.netout,
      storage_type: null,
      storage_content: null,
      storage_avail: null,
      storage_shared: null,
      cluster_version: null,
    });
  }

  // Storage rows
  for (const s of overview.storages) {
    rows.push({
      time: now,
      host,
      entity_type: 'storage',
      node: s.node,
      entity_id: `${s.node}/${s.storage}`,
      entity_name: s.storage,
      status: s.active ? 'active' : 'inactive',
      cpu: null,
      max_cpu: null,
      mem: null,
      max_mem: null,
      disk: s.used,
      max_disk: s.total,
      uptime: null,
      vmid: null,
      netin: null,
      netout: null,
      storage_type: s.type,
      storage_content: s.content,
      storage_avail: s.avail,
      storage_shared: s.shared === 1,
      cluster_version: null,
    });
  }

  return rows;
}

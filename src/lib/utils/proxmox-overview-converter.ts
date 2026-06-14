import type {
  ProxmoxClusterSnapshot,
  ProxmoxResource,
  ProxmoxStatsRow,
} from '@/types/proxmox';

/**
 * Map a guest resource (qemu or lxc) from /cluster/resources to a stats row.
 * `maxcpu` is the allocated core count, stored as `max_cpu`.
 */
function guestToRow(
  guest: ProxmoxResource,
  entityType: 'qemu' | 'lxc',
  host: string,
  now: Date,
): ProxmoxStatsRow {
  return {
    time: now,
    host,
    entity_type: entityType,
    node: guest.node ?? null,
    entity_id: String(guest.vmid ?? 0),
    entity_name: guest.name ?? null,
    status: guest.status,
    cpu: guest.cpu ?? 0,
    max_cpu: guest.maxcpu ?? 0,
    mem: guest.mem ?? 0,
    max_mem: guest.maxmem ?? 0,
    disk: guest.disk ?? 0,
    max_disk: guest.maxdisk ?? 0,
    uptime: guest.uptime ?? 0,
    vmid: guest.vmid ?? 0,
    netin: guest.netin ?? 0,
    netout: guest.netout ?? 0,
    storage_type: null,
    storage_content: null,
    storage_avail: null,
    storage_shared: null,
    cluster_version: null,
  };
}

/**
 * Convert a ProxmoxClusterSnapshot into a flat array of ProxmoxStatsRow, producing one row for the cluster and one row per node, VM, container, and storage.
 *
 * Entity IDs are stable (cluster=name, node=node name, qemu/lxc=String(vmid),
 * storage=node/name) so rows join to existing hypertable history.
 *
 * @param snapshot - Cluster snapshot from ProxmoxClient.getClusterSnapshot()
 * @param host - Host identifier to set on every produced row
 * @returns An array of ProxmoxStatsRow: the first element is the cluster row, followed by node rows, VM rows (entity_type 'qemu'), container rows (entity_type 'lxc'), and storage rows
 */
export function snapshotToRows(
  snapshot: ProxmoxClusterSnapshot,
  host: string,
): ProxmoxStatsRow[] {
  const now = new Date();
  const rows: ProxmoxStatsRow[] = [];

  const nodes: ProxmoxResource[] = [];
  const vms: ProxmoxResource[] = [];
  const containers: ProxmoxResource[] = [];
  const storages: ProxmoxResource[] = [];

  for (const resource of snapshot.resources) {
    switch (resource.type) {
      case 'node':
        nodes.push(resource);
        break;
      case 'qemu':
        if (!resource.template) vms.push(resource);
        break;
      case 'lxc':
        if (!resource.template) containers.push(resource);
        break;
      case 'storage':
        storages.push(resource);
        break;
      // sdn and pool resources carry no stats we persist
    }
  }

  // Node `cpu` is a 0-1 fraction; rows store absolute core usage (fraction * maxcpu)
  const totalCpu = nodes.reduce((sum, n) => sum + (n.maxcpu ?? 0), 0);
  const usedCpu = nodes.reduce((sum, n) => sum + (n.cpu ?? 0) * (n.maxcpu ?? 0), 0);
  const totalMemory = nodes.reduce((sum, n) => sum + (n.maxmem ?? 0), 0);
  const usedMemory = nodes.reduce((sum, n) => sum + (n.mem ?? 0), 0);
  const totalDisk = nodes.reduce((sum, n) => sum + (n.maxdisk ?? 0), 0);
  const usedDisk = nodes.reduce((sum, n) => sum + (n.disk ?? 0), 0);

  // Cluster-level row
  rows.push({
    time: now,
    host,
    entity_type: 'cluster',
    node: null,
    entity_id: snapshot.clusterName,
    entity_name: snapshot.clusterName,
    status: snapshot.quorate ? 'quorate' : 'no-quorum',
    cpu: usedCpu,
    max_cpu: totalCpu,
    mem: usedMemory,
    max_mem: totalMemory,
    disk: usedDisk,
    max_disk: totalDisk,
    uptime: null,
    vmid: null,
    netin: null,
    netout: null,
    storage_type: null,
    storage_content: null,
    storage_avail: null,
    storage_shared: null,
    cluster_version: snapshot.version,
  });

  // Node rows
  for (const node of nodes) {
    const nodeName = node.node ?? '';
    rows.push({
      time: now,
      host,
      entity_type: 'node',
      node: nodeName,
      entity_id: nodeName,
      entity_name: nodeName,
      status: node.status,
      cpu: (node.cpu ?? 0) * (node.maxcpu ?? 0),
      max_cpu: node.maxcpu ?? 0,
      mem: node.mem ?? 0,
      max_mem: node.maxmem ?? 0,
      disk: node.disk ?? 0,
      max_disk: node.maxdisk ?? 0,
      uptime: node.uptime ?? 0,
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
  for (const vm of vms) {
    rows.push(guestToRow(vm, 'qemu', host, now));
  }

  // Container rows
  for (const ct of containers) {
    rows.push(guestToRow(ct, 'lxc', host, now));
  }

  // Storage rows
  for (const s of storages) {
    const used = s.disk ?? 0;
    const total = s.maxdisk ?? 0;
    rows.push({
      time: now,
      host,
      entity_type: 'storage',
      node: s.node ?? null,
      entity_id: `${s.node}/${s.storage}`,
      entity_name: s.storage ?? null,
      // normalize 'available'/'unavailable' to the row's 'active'/'inactive' status
      status: s.status === 'available' ? 'active' : 'inactive',
      cpu: null,
      max_cpu: null,
      mem: null,
      max_mem: null,
      disk: used,
      max_disk: total,
      uptime: null,
      vmid: null,
      netin: null,
      netout: null,
      storage_type: s.plugintype ?? null,
      storage_content: s.content ?? null,
      // /cluster/resources has no avail field; derive it from total - used
      storage_avail: Math.max(0, total - used),
      storage_shared: (s.shared ?? 0) === 1,
      cluster_version: null,
    });
  }

  return rows;
}

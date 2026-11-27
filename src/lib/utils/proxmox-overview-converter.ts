import type {
  ProxmoxClusterSnapshot,
  ProxmoxGuestRates,
  ProxmoxResource,
} from '@/types/proxmox';
import type { NewProxmoxStat } from '@/lib/database/repositories/stats-repository';

const NO_RATES: ProxmoxGuestRates = {
  netInBytesPerSec: null,
  netOutBytesPerSec: null,
  diskReadBytesPerSec: null,
  diskWriteBytesPerSec: null,
};

interface GuestSample {
  uptime: number;
  counters: [number, number, number, number];
  sampledAtMs: number;
  rates: ProxmoxGuestRates;
}

function guestCounters(guest: ProxmoxResource): [number, number, number, number] | null {
  const { netin, netout, diskread, diskwrite } = guest;
  if (netin == null || netout == null || diskread == null || diskwrite == null) return null;
  return [netin, netout, diskread, diskwrite];
}

/**
 * Turns the cumulative counters in /cluster/resources into per-second rates, one tracker per connection.
 *
 * Proxmox refreshes guest stats about every 10 seconds (pvestatd), so a 1-second poll mostly sees the
 * same sample again: an unchanged sample repeats the rates it produced instead of reading as 0 B/s.
 * The time between samples is the guest's own uptime delta, which Proxmox reads together with the
 * counters, falling back to the worker's monotonic clock when uptime did not move.
 */
export class ProxmoxRateTracker {
  private readonly previous = new Map<string, GuestSample>();

  rates(guest: ProxmoxResource, entityType: 'qemu' | 'lxc', sampledAtMs: number): ProxmoxGuestRates {
    const key = `${entityType}/${guest.vmid ?? 0}`;
    const counters = guestCounters(guest);
    const uptime = guest.uptime ?? 0;
    if (guest.status !== 'running' || counters === null) {
      this.previous.delete(key);
      return NO_RATES;
    }

    const prev = this.previous.get(key);
    if (prev && prev.uptime === uptime && prev.counters.every((value, i) => value === counters[i])) {
      return prev.rates;
    }

    const rates = prev ? ratesBetween(prev, uptime, counters, sampledAtMs) : NO_RATES;
    this.previous.set(key, { uptime, counters, sampledAtMs, rates });
    return rates;
  }

  /** Forgets guests absent from the latest snapshot, so a guest that comes back starts blank. */
  retain(keys: Set<string>): void {
    for (const key of this.previous.keys()) {
      if (!keys.has(key)) this.previous.delete(key);
    }
  }
}

function ratesBetween(
  prev: GuestSample,
  uptime: number,
  counters: [number, number, number, number],
  sampledAtMs: number,
): ProxmoxGuestRates {
  // Any counter or the uptime going backwards is a restart (or a migration to a fresh process), not negative traffic.
  if (uptime < prev.uptime || counters.some((value, i) => value < prev.counters[i])) return NO_RATES;
  const seconds = uptime > prev.uptime ? uptime - prev.uptime : (sampledAtMs - prev.sampledAtMs) / 1000;
  if (!(seconds > 0)) return NO_RATES;
  const [netIn, netOut, diskRead, diskWrite] = counters.map((value, i) => (value - prev.counters[i]) / seconds);
  return {
    netInBytesPerSec: netIn,
    netOutBytesPerSec: netOut,
    diskReadBytesPerSec: diskRead,
    diskWriteBytesPerSec: diskWrite,
  };
}

/**
 * Map a guest resource (qemu or lxc) from /cluster/resources to a stats row.
 * `maxcpu` is the allocated core count, stored as `max_cpu`.
 */
const NULL_RATE_COLUMNS = {
  net_in_bytes_per_sec: null,
  net_out_bytes_per_sec: null,
  disk_read_bytes_per_sec: null,
  disk_write_bytes_per_sec: null,
} as const;

function guestToRow(
  guest: ProxmoxResource,
  entityType: 'qemu' | 'lxc',
  host: string,
  now: Date,
  rates: ProxmoxGuestRates,
): NewProxmoxStat {
  return {
    time: now,
    host,
    entity_type: entityType,
    node: guest.node ?? null,
    entity_id: String(guest.vmid ?? 0),
    entity_name: guest.name ?? null,
    status: guest.status ?? null,
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
    net_in_bytes_per_sec: rates.netInBytesPerSec,
    net_out_bytes_per_sec: rates.netOutBytesPerSec,
    disk_read_bytes_per_sec: rates.diskReadBytesPerSec,
    disk_write_bytes_per_sec: rates.diskWriteBytesPerSec,
    storage_type: null,
    storage_content: null,
    storage_avail: null,
    storage_shared: null,
    cluster_version: null,
  };
}

/**
 * Convert a ProxmoxClusterSnapshot into a flat array of insert rows, producing one row for the cluster and one row per node, VM, container, and storage.
 *
 * Entity IDs are stable (cluster=name, node=node name, qemu/lxc=String(vmid),
 * storage=node/name) so rows join to existing hypertable history.
 *
 * @param snapshot - Cluster snapshot from ProxmoxClient.getClusterSnapshot()
 * @param host - Host identifier to set on every produced row
 * @param rateTracker - Keeps the previous poll's counters. Pass the same one on every poll of a connection
 * @returns An array of insert rows: the first element is the cluster row, followed by node rows, VM rows (entity_type 'qemu'), container rows (entity_type 'lxc'), and storage rows
 */
export function snapshotToRows(
  snapshot: ProxmoxClusterSnapshot,
  host: string,
  rateTracker: ProxmoxRateTracker = new ProxmoxRateTracker(),
): NewProxmoxStat[] {
  const now = new Date();
  const rows: NewProxmoxStat[] = [];

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
    ...NULL_RATE_COLUMNS,
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
      status: node.status ?? null,
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
      ...NULL_RATE_COLUMNS,
      storage_type: null,
      storage_content: null,
      storage_avail: null,
      storage_shared: null,
      cluster_version: null,
    });
  }

  // VM rows
  for (const vm of vms) {
    rows.push(guestToRow(vm, 'qemu', host, now, rateTracker.rates(vm, 'qemu', snapshot.sampledAtMs)));
  }

  // Container rows
  for (const ct of containers) {
    rows.push(guestToRow(ct, 'lxc', host, now, rateTracker.rates(ct, 'lxc', snapshot.sampledAtMs)));
  }
  rateTracker.retain(new Set([
    ...vms.map((vm) => `qemu/${vm.vmid ?? 0}`),
    ...containers.map((ct) => `lxc/${ct.vmid ?? 0}`),
  ]));

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
      ...NULL_RATE_COLUMNS,
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

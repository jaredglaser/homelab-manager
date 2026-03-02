import type { ProxmoxStatsRow } from '@/types/proxmox';
import { generateMetric } from '../patterns';
import { PROXMOX_ENTITIES } from '../entities';

/**
 * Generate a single Proxmox stats snapshot for a given timestamp.
 * Returns one row per entity (cluster, node, qemu, lxc, storage),
 * matching the `proxmox_stats` hypertable schema.
 */
export function generateProxmoxSnapshot(time: Date): ProxmoxStatsRow[] {
  const timeMs = time.getTime();
  const timeStr = time.toISOString();

  return PROXMOX_ENTITIES.map((e) => {
    const entityKey = `${e.host}/${e.entityId}`;

    return {
      time: timeStr,
      host: e.host,
      entity_type: e.entityType,
      node: e.node,
      entity_id: e.entityId,
      entity_name: e.entityName,
      status: e.status,
      cpu: e.cpu ? Math.round(generateMetric(timeMs, entityKey, 'cpu', e.cpu) * 10000) / 10000 : null,
      max_cpu: e.maxCpu,
      mem: e.mem ? Math.round(generateMetric(timeMs, entityKey, 'mem', e.mem)) : null,
      max_mem: e.maxMem,
      disk: e.disk ? Math.round(generateMetric(timeMs, entityKey, 'disk', e.disk)) : null,
      max_disk: e.maxDisk,
      uptime: e.uptime > 0 ? e.uptime + Math.floor(timeMs / 1000) % 86400 : null,
      vmid: e.vmid,
      netin: e.netin ? Math.round(generateMetric(timeMs, entityKey, 'netin', e.netin)) : null,
      netout: e.netout ? Math.round(generateMetric(timeMs, entityKey, 'netout', e.netout)) : null,
      storage_type: e.storageType,
      storage_content: e.storageContent,
      storage_avail: e.storageAvail,
      storage_shared: e.storageShared,
      cluster_version: e.clusterVersion,
    };
  });
}

/**
 * Generate `seconds` worth of historical Proxmox data at 1-second intervals.
 * Rows are ordered oldest-first (ascending time).
 */
export function generateProxmoxHistory(seconds: number): ProxmoxStatsRow[] {
  const now = Date.now();
  const rows: ProxmoxStatsRow[] = [];

  for (let s = seconds; s >= 0; s--) {
    const time = new Date(now - s * 1000);
    rows.push(...generateProxmoxSnapshot(time));
  }

  return rows;
}

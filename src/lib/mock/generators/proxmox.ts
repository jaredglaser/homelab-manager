import type { ProxmoxStatsRow } from '@/types/proxmox';
import { generateMetric } from '@/lib/mock/patterns';
import { PROXMOX_ENTITIES } from '@/lib/mock/entities';

/** Fixed reference for uptime calculation — entity uptime values are "as of" this instant. */
const UPTIME_REFERENCE_MS = Date.UTC(2025, 0, 1); // 2025-01-01T00:00:00Z

/**
 * Generate a single Proxmox stats snapshot for a given timestamp.
 * Returns one row per entity (cluster, node, qemu, lxc, storage),
 * matching the `proxmox_stats` hypertable schema.
 */
export function generateProxmoxSnapshot(time: Date): ProxmoxStatsRow[] {
  const timeMs = time.getTime();
  const timeStr = time.toISOString();
  const elapsedSeconds = Math.max(0, Math.floor((timeMs - UPTIME_REFERENCE_MS) / 1000));

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
      uptime: e.uptime > 0 ? e.uptime + elapsedSeconds : null,
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
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const now = Date.now();
  const rows: ProxmoxStatsRow[] = [];

  for (let i = s; i >= 0; i--) {
    const time = new Date(now - i * 1000);
    rows.push(...generateProxmoxSnapshot(time));
  }

  return rows;
}

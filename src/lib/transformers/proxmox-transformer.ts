import type { LatestStatRow } from '@/lib/database/repositories/stats-repository';
import type { EntityMetadata } from '@/lib/transformers/docker-transformer';

/**
 * Proxmox stats reconstructed from database rows.
 * Contains only the fields stored in DB that the frontend needs.
 */
export interface ProxmoxStatsFromDB {
  id: string;
  entityType: 'node' | 'qemu' | 'lxc';
  name: string;
  vmid: number | null;
  node: string;
  status: string;
  stale: boolean;
  timestamp: Date;
  tags: string[];
  ipAddresses: string[];
  rates: {
    cpuPercent: number;
    memoryUsage: number;
    memoryLimit: number;
    memoryPercent: number;
    diskUsage: number;
    diskLimit: number;
    networkInBytesPerSec: number;
    networkOutBytesPerSec: number;
    diskReadBytesPerSec: number;
    diskWriteBytesPerSec: number;
    uptime: number;
  };
}

/** Map of stat type name to the field setter in ProxmoxStatsFromDB */
const PROXMOX_TYPE_MAP: Record<string, (stats: ProxmoxStatsFromDB, value: number) => void> = {
  cpu_percent: (s, v) => (s.rates.cpuPercent = v),
  memory_usage: (s, v) => (s.rates.memoryUsage = v),
  memory_limit: (s, v) => (s.rates.memoryLimit = v),
  memory_percent: (s, v) => (s.rates.memoryPercent = v),
  disk_usage: (s, v) => (s.rates.diskUsage = v),
  disk_limit: (s, v) => (s.rates.diskLimit = v),
  network_in_bytes_per_sec: (s, v) => (s.rates.networkInBytesPerSec = v),
  network_out_bytes_per_sec: (s, v) => (s.rates.networkOutBytesPerSec = v),
  disk_read_bytes_per_sec: (s, v) => (s.rates.diskReadBytesPerSec = v),
  disk_write_bytes_per_sec: (s, v) => (s.rates.diskWriteBytesPerSec = v),
  uptime: (s, v) => (s.rates.uptime = v),
  status: (s, v) => (s.status = v === 1 ? 'running' : 'stopped'),
};

/**
 * Parse entity path to extract node, type, and vmid.
 * Entity formats:
 *   - "nodename" → node
 *   - "nodename/qemu/100" → QEMU VM
 *   - "nodename/lxc/101" → LXC container
 */
export function parseProxmoxEntityPath(entityPath: string): {
  node: string;
  entityType: 'node' | 'qemu' | 'lxc';
  vmid: number | null;
} {
  const parts = entityPath.split('/');

  if (parts.length === 1) {
    return { node: parts[0], entityType: 'node', vmid: null };
  }

  if (parts.length === 3) {
    const guestType = parts[1] as 'qemu' | 'lxc';
    return { node: parts[0], entityType: guestType, vmid: parseInt(parts[2], 10) };
  }

  return { node: parts[0], entityType: 'node', vmid: null };
}

/**
 * Creates an empty ProxmoxStatsFromDB object with default values.
 * Uses metadata to populate display fields.
 */
function createEmptyProxmoxStats(
  entityId: string,
  metadata?: EntityMetadata
): ProxmoxStatsFromDB {
  const { node, entityType, vmid } = parseProxmoxEntityPath(entityId);
  const entityMeta = metadata?.get(entityId);

  const name = entityMeta?.get('name') ?? (entityType === 'node' ? node : `${entityType}/${vmid}`);
  const status = entityMeta?.get('status') ?? 'unknown';
  const tags = entityMeta?.get('tags')?.split(',').filter(Boolean) ?? [];
  const ipAddresses = entityMeta?.get('ip_addresses')?.split(',').filter(Boolean) ?? [];

  return {
    id: entityId,
    entityType,
    name,
    vmid,
    node,
    status,
    stale: false,
    timestamp: new Date(0),
    tags,
    ipAddresses,
    rates: {
      cpuPercent: 0,
      memoryUsage: 0,
      memoryLimit: 0,
      memoryPercent: 0,
      diskUsage: 0,
      diskLimit: 0,
      networkInBytesPerSec: 0,
      networkOutBytesPerSec: 0,
      diskReadBytesPerSec: 0,
      diskWriteBytesPerSec: 0,
      uptime: 0,
    },
  };
}

/**
 * Transform flat database rows into ProxmoxStatsFromDB objects.
 * Groups rows by entity and maps type names to object fields.
 */
export function transformProxmoxStats(
  rows: LatestStatRow[],
  metadata?: EntityMetadata
): Map<string, ProxmoxStatsFromDB> {
  const result = new Map<string, ProxmoxStatsFromDB>();

  for (const row of rows) {
    let stats = result.get(row.entity);
    if (!stats) {
      stats = createEmptyProxmoxStats(row.entity, metadata);
      result.set(row.entity, stats);
    }

    if (row.timestamp > stats.timestamp) {
      stats.timestamp = row.timestamp;
    }

    const setter = PROXMOX_TYPE_MAP[row.type];
    if (setter) {
      setter(stats, row.value);
    }
  }

  return result;
}

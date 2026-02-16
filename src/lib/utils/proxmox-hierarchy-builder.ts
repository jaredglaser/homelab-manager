import type { ProxmoxStatsFromDB } from '@/lib/transformers/proxmox-transformer';
import type { ProxmoxHierarchy, ProxmoxNodeEntry, NodeAggregatedStats } from '@/types/proxmox';

/**
 * Build a hierarchical structure from flat Proxmox stats.
 * Groups guests under their respective nodes.
 */
export function buildProxmoxHierarchy(stats: ProxmoxStatsFromDB[]): ProxmoxHierarchy {
  const hierarchy: ProxmoxHierarchy = new Map();

  // First pass: add all nodes
  for (const stat of stats) {
    if (stat.entityType === 'node') {
      hierarchy.set(stat.node, {
        data: stat,
        guests: new Map(),
      });
    }
  }

  // Second pass: add guests to their nodes
  for (const stat of stats) {
    if (stat.entityType === 'qemu' || stat.entityType === 'lxc') {
      let nodeEntry = hierarchy.get(stat.node);

      // Create a placeholder node entry if the node itself wasn't in the stats
      if (!nodeEntry) {
        nodeEntry = {
          data: createPlaceholderNodeStats(stat.node),
          guests: new Map(),
        };
        hierarchy.set(stat.node, nodeEntry);
      }

      nodeEntry.guests.set(stat.id, { data: stat });
    }
  }

  return hierarchy;
}

/**
 * Calculate aggregated stats for a node from its guests.
 */
export function aggregateNodeStats(node: ProxmoxNodeEntry): NodeAggregatedStats {
  let guestCount = 0;
  let runningCount = 0;
  let stoppedCount = 0;
  let totalGuestMemUsage = 0;
  let totalGuestMemLimit = 0;
  let totalGuestNetIn = 0;
  let totalGuestNetOut = 0;
  let totalGuestDiskRead = 0;
  let totalGuestDiskWrite = 0;

  for (const guest of node.guests.values()) {
    guestCount++;
    if (guest.data.status === 'running') runningCount++;
    else stoppedCount++;

    totalGuestMemUsage += guest.data.rates.memoryUsage;
    totalGuestMemLimit += guest.data.rates.memoryLimit;
    totalGuestNetIn += guest.data.rates.networkInBytesPerSec;
    totalGuestNetOut += guest.data.rates.networkOutBytesPerSec;
    totalGuestDiskRead += guest.data.rates.diskReadBytesPerSec;
    totalGuestDiskWrite += guest.data.rates.diskWriteBytesPerSec;
  }

  return {
    cpuPercent: node.data.rates.cpuPercent,
    memoryUsage: node.data.rates.memoryUsage,
    memoryLimit: node.data.rates.memoryLimit,
    memoryPercent: node.data.rates.memoryPercent,
    diskUsage: node.data.rates.diskUsage,
    diskLimit: node.data.rates.diskLimit,
    networkInBytesPerSec: totalGuestNetIn || node.data.rates.networkInBytesPerSec,
    networkOutBytesPerSec: totalGuestNetOut || node.data.rates.networkOutBytesPerSec,
    diskReadBytesPerSec: totalGuestDiskRead || node.data.rates.diskReadBytesPerSec,
    diskWriteBytesPerSec: totalGuestDiskWrite || node.data.rates.diskWriteBytesPerSec,
    guestCount,
    runningCount,
    stoppedCount,
    uptime: node.data.rates.uptime,
  };
}

function createPlaceholderNodeStats(nodeName: string): ProxmoxStatsFromDB {
  return {
    id: nodeName,
    entityType: 'node',
    name: nodeName,
    vmid: null,
    node: nodeName,
    status: 'unknown',
    stale: false,
    timestamp: new Date(0),
    tags: [],
    ipAddresses: [],
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
 * Format uptime in seconds to a human-readable string.
 */
export function formatUptime(seconds: number): string {
  if (seconds <= 0) return '—';

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Proxmox VE cluster monitoring types
 */

import type { ProxmoxStatsFromDB } from '@/lib/transformers/proxmox-transformer';

// ─── Rate Calculator Types ──────────────────────────────────────────────────────

/** Input to the Proxmox rate calculator (from API resource data) */
export interface ProxmoxRateInput {
  /** Entity identifier (e.g., "pve1", "pve1/qemu/100") */
  id: string;
  /** CPU usage as 0-1 fraction */
  cpu: number;
  /** Memory used in bytes */
  mem: number;
  /** Memory total in bytes */
  maxmem: number;
  /** Disk used in bytes */
  disk: number;
  /** Disk total in bytes */
  maxdisk: number;
  /** Cumulative network bytes in */
  netin: number;
  /** Cumulative network bytes out */
  netout: number;
  /** Cumulative disk bytes read */
  diskread: number;
  /** Cumulative disk bytes written */
  diskwrite: number;
  /** Uptime in seconds */
  uptime: number;
}

/** Output from the Proxmox rate calculator */
export interface ProxmoxStatsWithRates extends ProxmoxRateInput {
  rates: {
    cpuPercent: number;
    memoryPercent: number;
    networkInBytesPerSec: number;
    networkOutBytesPerSec: number;
    diskReadBytesPerSec: number;
    diskWriteBytesPerSec: number;
  };
}

// ─── Replication Types ──────────────────────────────────────────────────────────

export interface ProxmoxReplicationJob {
  id: string;
  guest: number;
  guestName: string;
  jobnum: number;
  source: string;
  target: string;
  type: string;
  schedule: string;
  lastSync: number | null;
  nextSync: number | null;
  duration: number | null;
  failCount: number;
  error: string | null;
  comment: string | null;
}

// ─── IP / Subnet Analysis Types ─────────────────────────────────────────────────

export interface IPAssignment {
  ip: string;
  entity: string;
  name: string;
  type: 'qemu' | 'lxc';
  vmid: number;
  node: string;
}

export interface SubnetInfo {
  cidr: string;
  network: string;
  prefix: number;
  usedIPs: IPAssignment[];
  totalHosts: number;
  usedCount: number;
  nextAvailable: string | null;
}

// ─── Hierarchy Types ────────────────────────────────────────────────────────────

export interface ProxmoxGuestEntry {
  data: ProxmoxStatsFromDB;
}

export interface ProxmoxNodeEntry {
  data: ProxmoxStatsFromDB;
  guests: Map<string, ProxmoxGuestEntry>;
}

/** Complete Proxmox hierarchy: nodes -> guests (VMs/LXCs) */
export type ProxmoxHierarchy = Map<string, ProxmoxNodeEntry>;

// ─── Aggregated Node Stats ──────────────────────────────────────────────────────

export interface NodeAggregatedStats {
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
  guestCount: number;
  runningCount: number;
  stoppedCount: number;
  uptime: number;
}

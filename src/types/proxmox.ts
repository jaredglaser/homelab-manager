/**
 * Proxmox VE API response types
 *
 * These types model the JSON responses from the Proxmox REST API.
 * All API responses are wrapped in { data: T }.
 */
import { z } from 'zod';

/** Proxmox (Perl) can serialize a number as a string, so a numeric string counts as the number. */
const zOptionalNumber = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : value),
  z.number().nullish(),
);

/** A guest named `1234` can arrive as a number. */
const zText = z.union([z.string(), z.number().transform(String)]).optional();

/** Entry of GET /api2/json/cluster/status: one `cluster` entry (absent on a standalone node) plus one per node. */
export const zProxmoxClusterStatus = z.object({
  type: z.string(),
  id: z.string().optional(),
  name: zText,
  nodes: zOptionalNumber,
  quorate: zOptionalNumber,
  version: zOptionalNumber,
});

export type ProxmoxClusterStatus = z.infer<typeof zProxmoxClusterStatus>;

/** Entry of GET /api2/json/cluster/resources. `netin`, `netout`, `diskread` and `diskwrite` are cumulative byte counters. */
export const zProxmoxResource = z.object({
  id: z.string(),
  type: z.string(),
  node: zText,
  status: z.string().optional(),
  name: zText,
  vmid: zOptionalNumber,
  /** 0-1 fraction of `maxcpu` */
  cpu: zOptionalNumber,
  maxcpu: zOptionalNumber,
  mem: zOptionalNumber,
  maxmem: zOptionalNumber,
  disk: zOptionalNumber,
  maxdisk: zOptionalNumber,
  uptime: zOptionalNumber,
  netin: zOptionalNumber,
  netout: zOptionalNumber,
  diskread: zOptionalNumber,
  diskwrite: zOptionalNumber,
  template: zOptionalNumber,
  storage: zText,
  content: z.string().optional(),
  plugintype: z.string().optional(),
  shared: zOptionalNumber,
});

export type ProxmoxResource = z.infer<typeof zProxmoxResource>;

/** Every Proxmox list response. Entries are parsed one by one, so one bad entry does not fail the rest. */
export const zProxmoxListEnvelope = z.object({ data: z.array(z.unknown()) });

export const zProxmoxVersionEnvelope = z.object({
  data: z.object({ version: z.string(), release: z.string().optional() }),
});

/**
 * Cluster snapshot assembled from GET /cluster/status plus GET /cluster/resources.
 * The whole cluster is captured in 2 requests per poll cycle regardless of node count.
 */
export interface ProxmoxClusterSnapshot {
  clusterName: string;
  quorate: boolean;
  version: number;
  resources: ProxmoxResource[];
  /** Monotonic time (performance.now()) when both responses had arrived, immune to wall-clock changes on the worker. */
  sampledAtMs: number;
}

/** Per-second rates the worker derives from consecutive polls. Null where no rate exists (first point, restart, stopped). */
export interface ProxmoxGuestRates {
  netInBytesPerSec: number | null;
  netOutBytesPerSec: number | null;
  diskReadBytesPerSec: number | null;
  diskWriteBytesPerSec: number | null;
}

/** `host` is the Proxmox connection the row came from. Every key built from a node or guest carries it. */
export interface ProxmoxNode {
  host: string;
  node: string;
  status: 'online' | 'offline' | 'unknown';
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  uptime: number;
}

export interface ProxmoxGuest extends ProxmoxGuestRates {
  host: string;
  node: string;
  vmid: number;
  name: string;
  status: string;
  cpu: number;
  cpus: number;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  uptime: number;
}

export interface ProxmoxStorage {
  host: string;
  node: string;
  storage: string;
  type: string;
  content: string;
  active: number;
  enabled: number;
  shared: number;
  used: number;
  avail: number;
  total: number;
  used_fraction: number;
}

/** Presentation row for a VM or LXC container in the guest table. */
export type GuestRow = ProxmoxGuestRates & {
  host: string
  node: string
  vmid: number
  name: string
  status: string
  cpu: number
  cpus: number
  mem: number
  maxmem: number
}

export const zProxmoxEntityType = z.enum(['cluster', 'node', 'qemu', 'lxc', 'storage']);

export type ProxmoxEntityType = z.infer<typeof zProxmoxEntityType>;

export const PROXMOX_ENTITY_TYPE_VALUES = zProxmoxEntityType.options;

/** Wide row from proxmox_stats hypertable */
export interface ProxmoxStatsRow {
  /** Epoch ms, converted at the repository read path */
  time: number;
  host: string;
  entity_type: ProxmoxEntityType;
  node: string | null;
  entity_id: string;
  entity_name: string | null;
  status: string | null;
  cpu: number | null;
  max_cpu: number | null;
  mem: number | null;
  max_mem: number | null;
  disk: number | null;
  max_disk: number | null;
  uptime: number | null;
  vmid: number | null;
  net_in_bytes_per_sec: number | null;
  net_out_bytes_per_sec: number | null;
  disk_read_bytes_per_sec: number | null;
  disk_write_bytes_per_sec: number | null;
  storage_type: string | null;
  storage_content: string | null;
  storage_avail: number | null;
  storage_shared: boolean | null;
  cluster_version: number | null;
}

/** Aggregated cluster overview for the dashboard */
export interface ProxmoxClusterOverview {
  clusterName: string;
  quorate: boolean;
  version: number;
  nodes: ProxmoxNode[];
  vms: ProxmoxGuest[];
  containers: ProxmoxGuest[];
  storages: ProxmoxStorage[];
  totals: {
    totalCpu: number;
    usedCpu: number;
    totalMemory: number;
    usedMemory: number;
    totalDisk: number;
    usedDisk: number;
    runningVMs: number;
    stoppedVMs: number;
    runningContainers: number;
    stoppedContainers: number;
  };
}

export const PROXMOX_COLLECTOR_STATES = [
  'collecting',
  'unreachable',
  'token_rejected',
  'certificate_refused',
] as const;

export type ProxmoxCollectorStateKind = (typeof PROXMOX_COLLECTOR_STATES)[number];

/** What the worker last recorded for one Proxmox connection. `reason` is log detail for the console, never UI copy. */
export interface ProxmoxCollectorState {
  connectionId: string;
  host: string;
  port: number;
  state: ProxmoxCollectorStateKind;
  reason: string | null;
  /** Epoch ms of the last poll that stored data */
  lastSuccessAt: number | null;
  /** Epoch ms */
  updatedAt: number;
}

/** What browsers get: the recorded state without `reason`, which stays in the table and the worker log. */
export type ProxmoxCollectorStateView = Omit<ProxmoxCollectorState, 'reason'>;

/** A saved Proxmox connection as every role sees it. The token secret is never part of it. */
export interface ProxmoxConnectionSummary {
  id: number;
  name: string;
  address: string;
  port: number;
  tokenId: string;
  allowSelfSignedCerts: boolean;
}

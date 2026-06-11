/**
 * Proxmox VE API response types
 *
 * These types model the JSON responses from the Proxmox REST API.
 * All API responses are wrapped in { data: T }.
 */

/** Generic Proxmox API response wrapper */
export interface ProxmoxResponse<T> {
  data: T;
}

/** Node status from GET /api2/json/nodes */
export interface ProxmoxNode {
  node: string;
  status: 'online' | 'offline' | 'unknown';
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  uptime: number;
  type: string;
  id: string;
  level?: string;
  ssl_fingerprint?: string;
}

/** Cluster status entry from GET /api2/json/cluster/status */
export interface ProxmoxClusterStatus {
  type: 'cluster' | 'node';
  id: string;
  name: string;
  /** Only present when type === 'cluster' */
  nodes?: number;
  quorate?: number;
  version?: number;
  /** Only present when type === 'node' */
  nodeid?: number;
  ip?: string;
  online?: number;
  local?: number;
  level?: string;
}

/** Resource from GET /api2/json/cluster/resources */
export interface ProxmoxResource {
  id: string;
  type: 'qemu' | 'lxc' | 'node' | 'storage' | 'sdn' | 'pool';
  node?: string;
  status: string;
  name?: string;
  vmid?: number;
  /** CPU usage (0-1 fraction for VMs, absolute count for nodes) */
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  netin?: number;
  netout?: number;
  diskread?: number;
  diskwrite?: number;
  template?: number;
  pool?: string;
  hastate?: string;
  storage?: string;
  content?: string;
  plugintype?: string;
  shared?: number;
}

/**
 * Cluster snapshot assembled from GET /cluster/status plus GET /cluster/resources.
 * Replaces the per-node fan-out (qemu/lxc/storage per online node): the whole
 * cluster is captured in 2 requests per poll cycle regardless of node count.
 */
export interface ProxmoxClusterSnapshot {
  clusterName: string;
  quorate: boolean;
  version: number;
  resources: ProxmoxResource[];
}

/** VM (QEMU) from GET /api2/json/nodes/{node}/qemu */
export interface ProxmoxVM {
  vmid: number;
  name: string;
  status: 'running' | 'stopped' | 'paused' | 'suspended';
  cpu: number;
  cpus: number;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  uptime: number;
  netin: number;
  netout: number;
  diskread: number;
  diskwrite: number;
  pid?: number;
  template?: number;
  tags?: string;
}

/** Container (LXC) from GET /api2/json/nodes/{node}/lxc */
export interface ProxmoxContainer {
  vmid: number;
  name: string;
  status: 'running' | 'stopped';
  type: string;
  cpu: number;
  cpus: number;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  uptime: number;
  netin: number;
  netout: number;
  diskread: number;
  diskwrite: number;
  swap: number;
  maxswap: number;
  template?: number;
  tags?: string;
}

/** Storage from GET /api2/json/nodes/{node}/storage */
export interface ProxmoxStorage {
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

/**
 * Flattened presentation row for a VM or LXC container, used in guest table rendering.
 * Derived from ProxmoxVM / ProxmoxContainer with node context stripped.
 */
export type GuestRow = {
  vmid: number
  name: string
  status: string
  cpu: number
  cpus: number
  mem: number
  maxmem: number
  netin: number
  netout: number
}

/** Wide row from proxmox_stats hypertable */
export interface ProxmoxStatsRow {
  time: string | Date;
  host: string;
  entity_type: 'cluster' | 'node' | 'qemu' | 'lxc' | 'storage';
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
  netin: number | null;
  netout: number | null;
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
  vms: (ProxmoxVM & { node: string })[];
  containers: (ProxmoxContainer & { node: string })[];
  storages: (ProxmoxStorage & { node: string })[];
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

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

import type { MetricProfile } from '@/lib/mock/patterns';

// ─── Docker Entities ─────────────────────────────────────────────────────────

export interface DockerEntityDef {
  host: string;
  hostName: string;
  containerId: string;
  containerName: string;
  image: string;
  iconSlug: string;
  serviceKey: string;
  cpu: MetricProfile;
  memoryUsage: MetricProfile;
  memoryLimit: number;
  networkRx: MetricProfile;
  networkTx: MetricProfile;
  blockRead: MetricProfile;
  blockWrite: MetricProfile;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;

export const DOCKER_ENTITIES: DockerEntityDef[] = [
  // ── nas01 ──────────────────────────────────────────────────────────────────
  {
    host: '192.168.1.10',
    hostName: 'nas01',
    containerId: 'a1b2c3d4e5f6',
    containerName: 'nginx-proxy',
    image: 'nginx:latest',
    iconSlug: 'nginx',
    serviceKey: 'nginx-proxy',
    cpu: { base: 5, amplitude: 3, periodMs: 10 * MINUTE, noiseLevel: 1.5, min: 0.5, max: 15 },
    memoryUsage: { base: 150_000_000, amplitude: 20_000_000, periodMs: 30 * MINUTE, noiseLevel: 5_000_000, min: 100_000_000, max: 400_000_000 },
    memoryLimit: 512_000_000,
    networkRx: { base: 500_000, amplitude: 300_000, periodMs: 5 * MINUTE, noiseLevel: 100_000, min: 10_000, max: 2_000_000 },
    networkTx: { base: 800_000, amplitude: 400_000, periodMs: 5 * MINUTE, noiseLevel: 150_000, min: 10_000, max: 3_000_000 },
    blockRead: { base: 50_000, amplitude: 30_000, periodMs: 15 * MINUTE, noiseLevel: 20_000, min: 0, max: 500_000 },
    blockWrite: { base: 20_000, amplitude: 10_000, periodMs: 15 * MINUTE, noiseLevel: 8_000, min: 0, max: 200_000 },
  },
  {
    host: '192.168.1.10',
    hostName: 'nas01',
    containerId: 'b2c3d4e5f6a7',
    containerName: 'plex',
    image: 'plexinc/pms-docker:latest',
    iconSlug: 'plex',
    serviceKey: 'plex',
    cpu: { base: 15, amplitude: 20, periodMs: 8 * MINUTE, noiseLevel: 8, min: 2, max: 55 },
    memoryUsage: { base: 2_000_000_000, amplitude: 500_000_000, periodMs: 20 * MINUTE, noiseLevel: 200_000_000, min: 1_000_000_000, max: 3_800_000_000 },
    memoryLimit: 4_000_000_000,
    networkRx: { base: 200_000, amplitude: 100_000, periodMs: 10 * MINUTE, noiseLevel: 50_000, min: 5_000, max: 1_000_000 },
    networkTx: { base: 5_000_000, amplitude: 4_000_000, periodMs: 8 * MINUTE, noiseLevel: 2_000_000, min: 50_000, max: 15_000_000 },
    blockRead: { base: 2_000_000, amplitude: 1_500_000, periodMs: 8 * MINUTE, noiseLevel: 800_000, min: 10_000, max: 8_000_000 },
    blockWrite: { base: 100_000, amplitude: 80_000, periodMs: 15 * MINUTE, noiseLevel: 50_000, min: 0, max: 1_000_000 },
  },
  {
    host: '192.168.1.10',
    hostName: 'nas01',
    containerId: 'c3d4e5f6a7b8',
    containerName: 'homeassistant',
    image: 'homeassistant/home-assistant:stable',
    iconSlug: 'home-assistant',
    serviceKey: 'homeassistant',
    cpu: { base: 4.5, amplitude: 1.5, periodMs: 15 * MINUTE, noiseLevel: 1, min: 1, max: 10 },
    memoryUsage: { base: 300_000_000, amplitude: 50_000_000, periodMs: HOUR, noiseLevel: 20_000_000, min: 200_000_000, max: 500_000_000 },
    memoryLimit: 1_000_000_000,
    networkRx: { base: 50_000, amplitude: 30_000, periodMs: 10 * MINUTE, noiseLevel: 15_000, min: 1_000, max: 200_000 },
    networkTx: { base: 40_000, amplitude: 20_000, periodMs: 10 * MINUTE, noiseLevel: 10_000, min: 1_000, max: 150_000 },
    blockRead: { base: 30_000, amplitude: 15_000, periodMs: 20 * MINUTE, noiseLevel: 10_000, min: 0, max: 200_000 },
    blockWrite: { base: 80_000, amplitude: 40_000, periodMs: 20 * MINUTE, noiseLevel: 25_000, min: 0, max: 300_000 },
  },
  {
    host: '192.168.1.10',
    hostName: 'nas01',
    containerId: 'd4e5f6a7b8c9',
    containerName: 'postgres',
    image: 'timescale/timescaledb:latest-pg16',
    iconSlug: 'postgres',
    serviceKey: 'postgres',
    cpu: { base: 11, amplitude: 4, periodMs: 5 * MINUTE, noiseLevel: 3, min: 3, max: 25 },
    memoryUsage: { base: 1_500_000_000, amplitude: 300_000_000, periodMs: 30 * MINUTE, noiseLevel: 100_000_000, min: 800_000_000, max: 3_500_000_000 },
    memoryLimit: 4_000_000_000,
    networkRx: { base: 300_000, amplitude: 200_000, periodMs: 5 * MINUTE, noiseLevel: 80_000, min: 10_000, max: 1_500_000 },
    networkTx: { base: 400_000, amplitude: 250_000, periodMs: 5 * MINUTE, noiseLevel: 100_000, min: 10_000, max: 2_000_000 },
    blockRead: { base: 1_000_000, amplitude: 800_000, periodMs: 5 * MINUTE, noiseLevel: 400_000, min: 10_000, max: 5_000_000 },
    blockWrite: { base: 500_000, amplitude: 400_000, periodMs: 5 * MINUTE, noiseLevel: 200_000, min: 10_000, max: 3_000_000 },
  },
  {
    host: '192.168.1.10',
    hostName: 'nas01',
    containerId: 'e5f6a7b8c9d0',
    containerName: 'grafana',
    image: 'grafana/grafana:latest',
    iconSlug: 'grafana',
    serviceKey: 'grafana',
    cpu: { base: 2.5, amplitude: 1.5, periodMs: 20 * MINUTE, noiseLevel: 0.8, min: 0.5, max: 8 },
    memoryUsage: { base: 200_000_000, amplitude: 30_000_000, periodMs: HOUR, noiseLevel: 15_000_000, min: 120_000_000, max: 400_000_000 },
    memoryLimit: 512_000_000,
    networkRx: { base: 20_000, amplitude: 15_000, periodMs: 10 * MINUTE, noiseLevel: 8_000, min: 1_000, max: 100_000 },
    networkTx: { base: 30_000, amplitude: 20_000, periodMs: 10 * MINUTE, noiseLevel: 10_000, min: 1_000, max: 150_000 },
    blockRead: { base: 40_000, amplitude: 25_000, periodMs: 15 * MINUTE, noiseLevel: 15_000, min: 0, max: 200_000 },
    blockWrite: { base: 15_000, amplitude: 10_000, periodMs: 15 * MINUTE, noiseLevel: 5_000, min: 0, max: 100_000 },
  },
  {
    host: '192.168.1.10',
    hostName: 'nas01',
    containerId: 'f6a7b8c9d0e1',
    containerName: 'traefik',
    image: 'traefik:v3',
    iconSlug: 'traefik',
    serviceKey: 'traefik',
    cpu: { base: 3, amplitude: 2, periodMs: 5 * MINUTE, noiseLevel: 1.2, min: 0.5, max: 10 },
    memoryUsage: { base: 100_000_000, amplitude: 15_000_000, periodMs: 30 * MINUTE, noiseLevel: 8_000_000, min: 60_000_000, max: 200_000_000 },
    memoryLimit: 256_000_000,
    networkRx: { base: 1_200_000, amplitude: 800_000, periodMs: 5 * MINUTE, noiseLevel: 400_000, min: 50_000, max: 5_000_000 },
    networkTx: { base: 1_500_000, amplitude: 1_000_000, periodMs: 5 * MINUTE, noiseLevel: 500_000, min: 50_000, max: 6_000_000 },
    blockRead: { base: 5_000, amplitude: 3_000, periodMs: 20 * MINUTE, noiseLevel: 2_000, min: 0, max: 50_000 },
    blockWrite: { base: 10_000, amplitude: 5_000, periodMs: 20 * MINUTE, noiseLevel: 3_000, min: 0, max: 80_000 },
  },

  // ── server02 ───────────────────────────────────────────────────────────────
  {
    host: '192.168.1.20',
    hostName: 'server02',
    containerId: 'a7b8c9d0e1f2',
    containerName: 'jellyfin',
    image: 'jellyfin/jellyfin:latest',
    iconSlug: 'jellyfin',
    serviceKey: 'jellyfin',
    cpu: { base: 25, amplitude: 25, periodMs: 10 * MINUTE, noiseLevel: 10, min: 3, max: 70 },
    memoryUsage: { base: 3_000_000_000, amplitude: 1_000_000_000, periodMs: 15 * MINUTE, noiseLevel: 500_000_000, min: 1_500_000_000, max: 7_500_000_000 },
    memoryLimit: 8_000_000_000,
    networkRx: { base: 100_000, amplitude: 80_000, periodMs: 10 * MINUTE, noiseLevel: 40_000, min: 5_000, max: 500_000 },
    networkTx: { base: 8_000_000, amplitude: 6_000_000, periodMs: 10 * MINUTE, noiseLevel: 3_000_000, min: 50_000, max: 25_000_000 },
    blockRead: { base: 3_000_000, amplitude: 2_500_000, periodMs: 10 * MINUTE, noiseLevel: 1_200_000, min: 20_000, max: 12_000_000 },
    blockWrite: { base: 200_000, amplitude: 150_000, periodMs: 15 * MINUTE, noiseLevel: 80_000, min: 0, max: 1_500_000 },
  },
  {
    host: '192.168.1.20',
    hostName: 'server02',
    containerId: 'b8c9d0e1f2a3',
    containerName: 'vaultwarden',
    image: 'vaultwarden/server:latest',
    iconSlug: 'vaultwarden',
    serviceKey: 'vaultwarden',
    cpu: { base: 2, amplitude: 1.5, periodMs: 30 * MINUTE, noiseLevel: 0.8, min: 0.3, max: 8 },
    memoryUsage: { base: 120_000_000, amplitude: 20_000_000, periodMs: HOUR, noiseLevel: 10_000_000, min: 80_000_000, max: 300_000_000 },
    memoryLimit: 512_000_000,
    networkRx: { base: 5_000, amplitude: 3_000, periodMs: 15 * MINUTE, noiseLevel: 2_000, min: 500, max: 30_000 },
    networkTx: { base: 8_000, amplitude: 5_000, periodMs: 15 * MINUTE, noiseLevel: 3_000, min: 500, max: 50_000 },
    blockRead: { base: 5_000, amplitude: 3_000, periodMs: 30 * MINUTE, noiseLevel: 2_000, min: 0, max: 30_000 },
    blockWrite: { base: 10_000, amplitude: 8_000, periodMs: 30 * MINUTE, noiseLevel: 5_000, min: 0, max: 80_000 },
  },
  {
    host: '192.168.1.20',
    hostName: 'server02',
    containerId: 'c9d0e1f2a3b4',
    containerName: 'pihole',
    image: 'pihole/pihole:latest',
    iconSlug: 'pi-hole',
    serviceKey: 'pihole',
    cpu: { base: 1.2, amplitude: 0.8, periodMs: 10 * MINUTE, noiseLevel: 0.4, min: 0.2, max: 4 },
    memoryUsage: { base: 80_000_000, amplitude: 10_000_000, periodMs: HOUR, noiseLevel: 5_000_000, min: 50_000_000, max: 150_000_000 },
    memoryLimit: 256_000_000,
    networkRx: { base: 15_000, amplitude: 10_000, periodMs: 5 * MINUTE, noiseLevel: 5_000, min: 1_000, max: 80_000 },
    networkTx: { base: 12_000, amplitude: 8_000, periodMs: 5 * MINUTE, noiseLevel: 4_000, min: 1_000, max: 60_000 },
    blockRead: { base: 2_000, amplitude: 1_500, periodMs: 20 * MINUTE, noiseLevel: 1_000, min: 0, max: 15_000 },
    blockWrite: { base: 3_000, amplitude: 2_000, periodMs: 20 * MINUTE, noiseLevel: 1_500, min: 0, max: 20_000 },
  },
  {
    host: '192.168.1.20',
    hostName: 'server02',
    containerId: 'd0e1f2a3b4c5',
    containerName: 'portainer',
    image: 'portainer/portainer-ce:latest',
    iconSlug: 'portainer',
    serviceKey: 'portainer',
    cpu: { base: 1.5, amplitude: 1, periodMs: 15 * MINUTE, noiseLevel: 0.6, min: 0.2, max: 5 },
    memoryUsage: { base: 50_000_000, amplitude: 10_000_000, periodMs: HOUR, noiseLevel: 5_000_000, min: 30_000_000, max: 120_000_000 },
    memoryLimit: 128_000_000,
    networkRx: { base: 3_000, amplitude: 2_000, periodMs: 10 * MINUTE, noiseLevel: 1_500, min: 200, max: 20_000 },
    networkTx: { base: 5_000, amplitude: 3_000, periodMs: 10 * MINUTE, noiseLevel: 2_000, min: 200, max: 30_000 },
    blockRead: { base: 3_000, amplitude: 2_000, periodMs: 20 * MINUTE, noiseLevel: 1_500, min: 0, max: 20_000 },
    blockWrite: { base: 2_000, amplitude: 1_500, periodMs: 20 * MINUTE, noiseLevel: 1_000, min: 0, max: 15_000 },
  },
];

// ─── ZFS Entities ────────────────────────────────────────────────────────────

export interface ZFSEntityDef {
  host: string;
  pool: string;
  entity: string;
  entityType: 'pool' | 'vdev' | 'disk';
  indent: number;
  capacityAlloc: number;
  capacityFree: number;
  readOps: MetricProfile;
  writeOps: MetricProfile;
  readBytes: MetricProfile;
  writeBytes: MetricProfile;
  utilization: MetricProfile;
}

export const ZFS_ENTITIES: ZFSEntityDef[] = [
  // ── tank pool (mirrored) ──────────────────────────────────────────────────
  {
    host: 'nas01', pool: 'tank', entity: 'tank', entityType: 'pool', indent: 0,
    capacityAlloc: 3_200_000_000_000, capacityFree: 5_600_000_000_000,
    readOps: { base: 120, amplitude: 80, periodMs: 5 * MINUTE, noiseLevel: 40, min: 0, max: 500 },
    writeOps: { base: 60, amplitude: 40, periodMs: 5 * MINUTE, noiseLevel: 25, min: 0, max: 300 },
    readBytes: { base: 5_000_000, amplitude: 4_000_000, periodMs: 5 * MINUTE, noiseLevel: 2_000_000, min: 0, max: 20_000_000 },
    writeBytes: { base: 2_000_000, amplitude: 1_500_000, periodMs: 5 * MINUTE, noiseLevel: 800_000, min: 0, max: 10_000_000 },
    utilization: { base: 15, amplitude: 10, periodMs: 5 * MINUTE, noiseLevel: 5, min: 0, max: 80 },
  },
  {
    host: 'nas01', pool: 'tank', entity: 'mirror-0', entityType: 'vdev', indent: 2,
    capacityAlloc: 3_200_000_000_000, capacityFree: 5_600_000_000_000,
    readOps: { base: 120, amplitude: 80, periodMs: 5 * MINUTE, noiseLevel: 40, min: 0, max: 500 },
    writeOps: { base: 60, amplitude: 40, periodMs: 5 * MINUTE, noiseLevel: 25, min: 0, max: 300 },
    readBytes: { base: 5_000_000, amplitude: 4_000_000, periodMs: 5 * MINUTE, noiseLevel: 2_000_000, min: 0, max: 20_000_000 },
    writeBytes: { base: 2_000_000, amplitude: 1_500_000, periodMs: 5 * MINUTE, noiseLevel: 800_000, min: 0, max: 10_000_000 },
    utilization: { base: 15, amplitude: 10, periodMs: 5 * MINUTE, noiseLevel: 5, min: 0, max: 80 },
  },
  {
    host: 'nas01', pool: 'tank', entity: 'sda', entityType: 'disk', indent: 4,
    capacityAlloc: 0, capacityFree: 0,
    readOps: { base: 60, amplitude: 40, periodMs: 5 * MINUTE, noiseLevel: 20, min: 0, max: 250 },
    writeOps: { base: 30, amplitude: 20, periodMs: 5 * MINUTE, noiseLevel: 12, min: 0, max: 150 },
    readBytes: { base: 2_500_000, amplitude: 2_000_000, periodMs: 5 * MINUTE, noiseLevel: 1_000_000, min: 0, max: 10_000_000 },
    writeBytes: { base: 1_000_000, amplitude: 750_000, periodMs: 5 * MINUTE, noiseLevel: 400_000, min: 0, max: 5_000_000 },
    utilization: { base: 12, amplitude: 8, periodMs: 5 * MINUTE, noiseLevel: 4, min: 0, max: 70 },
  },
  {
    host: 'nas01', pool: 'tank', entity: 'sdb', entityType: 'disk', indent: 4,
    capacityAlloc: 0, capacityFree: 0,
    readOps: { base: 60, amplitude: 40, periodMs: 5 * MINUTE, noiseLevel: 20, min: 0, max: 250 },
    writeOps: { base: 30, amplitude: 20, periodMs: 5 * MINUTE, noiseLevel: 12, min: 0, max: 150 },
    readBytes: { base: 2_500_000, amplitude: 2_000_000, periodMs: 5 * MINUTE, noiseLevel: 1_000_000, min: 0, max: 10_000_000 },
    writeBytes: { base: 1_000_000, amplitude: 750_000, periodMs: 5 * MINUTE, noiseLevel: 400_000, min: 0, max: 5_000_000 },
    utilization: { base: 12, amplitude: 8, periodMs: 5 * MINUTE, noiseLevel: 4, min: 0, max: 70 },
  },

  // ── fast pool (single NVMe) ───────────────────────────────────────────────
  {
    host: 'nas01', pool: 'fast', entity: 'fast', entityType: 'pool', indent: 0,
    capacityAlloc: 180_000_000_000, capacityFree: 750_000_000_000,
    readOps: { base: 800, amplitude: 500, periodMs: 3 * MINUTE, noiseLevel: 200, min: 0, max: 3000 },
    writeOps: { base: 400, amplitude: 300, periodMs: 3 * MINUTE, noiseLevel: 150, min: 0, max: 2000 },
    readBytes: { base: 50_000_000, amplitude: 40_000_000, periodMs: 3 * MINUTE, noiseLevel: 20_000_000, min: 0, max: 200_000_000 },
    writeBytes: { base: 25_000_000, amplitude: 20_000_000, periodMs: 3 * MINUTE, noiseLevel: 10_000_000, min: 0, max: 100_000_000 },
    utilization: { base: 25, amplitude: 15, periodMs: 3 * MINUTE, noiseLevel: 8, min: 0, max: 90 },
  },
  {
    host: 'nas01', pool: 'fast', entity: 'nvme0n1', entityType: 'disk', indent: 2,
    capacityAlloc: 180_000_000_000, capacityFree: 750_000_000_000,
    readOps: { base: 800, amplitude: 500, periodMs: 3 * MINUTE, noiseLevel: 200, min: 0, max: 3000 },
    writeOps: { base: 400, amplitude: 300, periodMs: 3 * MINUTE, noiseLevel: 150, min: 0, max: 2000 },
    readBytes: { base: 50_000_000, amplitude: 40_000_000, periodMs: 3 * MINUTE, noiseLevel: 20_000_000, min: 0, max: 200_000_000 },
    writeBytes: { base: 25_000_000, amplitude: 20_000_000, periodMs: 3 * MINUTE, noiseLevel: 10_000_000, min: 0, max: 100_000_000 },
    utilization: { base: 25, amplitude: 15, periodMs: 3 * MINUTE, noiseLevel: 8, min: 0, max: 90 },
  },
];

// ─── Proxmox Entities ────────────────────────────────────────────────────────

export interface ProxmoxEntityDef {
  entityType: 'cluster' | 'node' | 'qemu' | 'lxc' | 'storage';
  host: string;
  node: string | null;
  entityId: string;
  entityName: string;
  status: string;
  vmid: number | null;
  maxCpu: number | null;
  maxMem: number | null;
  maxDisk: number | null;
  uptime: number;
  storageType: string | null;
  storageContent: string | null;
  storageAvail: number | null;
  storageShared: boolean | null;
  clusterVersion: number | null;
  cpu: MetricProfile | null;
  mem: MetricProfile | null;
  disk: MetricProfile | null;
  netin: MetricProfile | null;
  netout: MetricProfile | null;
}

export const PROXMOX_HOST = '192.168.1.100';

export const PROXMOX_ENTITIES: ProxmoxEntityDef[] = [
  // ── Cluster ────────────────────────────────────────────────────────────────
  {
    entityType: 'cluster', host: PROXMOX_HOST, node: null,
    entityId: 'homelab', entityName: 'homelab', status: 'quorate',
    vmid: null, maxCpu: null, maxMem: null, maxDisk: null, uptime: 0,
    storageType: null, storageContent: null, storageAvail: null, storageShared: null,
    clusterVersion: 8,
    cpu: null, mem: null, disk: null, netin: null, netout: null,
  },

  // ── Nodes ──────────────────────────────────────────────────────────────────
  {
    entityType: 'node', host: PROXMOX_HOST, node: 'pve1',
    entityId: 'pve1', entityName: 'pve1', status: 'online',
    vmid: null, maxCpu: 4, maxMem: 32_000_000_000, maxDisk: 500_000_000_000, uptime: 1_200_000,
    storageType: null, storageContent: null, storageAvail: null, storageShared: null,
    clusterVersion: null,
    cpu: { base: 0.25, amplitude: 0.15, periodMs: 10 * MINUTE, noiseLevel: 0.05, min: 0.02, max: 0.9 },
    mem: { base: 18_000_000_000, amplitude: 4_000_000_000, periodMs: 30 * MINUTE, noiseLevel: 1_000_000_000, min: 8_000_000_000, max: 30_000_000_000 },
    disk: { base: 120_000_000_000, amplitude: 20_000_000_000, periodMs: HOUR, noiseLevel: 5_000_000_000, min: 50_000_000_000, max: 400_000_000_000 },
    netin: null, netout: null,
  },
  {
    entityType: 'node', host: PROXMOX_HOST, node: 'pve2',
    entityId: 'pve2', entityName: 'pve2', status: 'online',
    vmid: null, maxCpu: 4, maxMem: 16_000_000_000, maxDisk: 250_000_000_000, uptime: 900_000,
    storageType: null, storageContent: null, storageAvail: null, storageShared: null,
    clusterVersion: null,
    cpu: { base: 0.35, amplitude: 0.2, periodMs: 8 * MINUTE, noiseLevel: 0.08, min: 0.03, max: 0.95 },
    mem: { base: 10_000_000_000, amplitude: 2_000_000_000, periodMs: 20 * MINUTE, noiseLevel: 800_000_000, min: 4_000_000_000, max: 15_000_000_000 },
    disk: { base: 80_000_000_000, amplitude: 15_000_000_000, periodMs: HOUR, noiseLevel: 4_000_000_000, min: 30_000_000_000, max: 200_000_000_000 },
    netin: null, netout: null,
  },

  // ── QEMU VMs ───────────────────────────────────────────────────────────────
  {
    entityType: 'qemu', host: PROXMOX_HOST, node: 'pve1',
    entityId: '100', entityName: 'ubuntu-server', status: 'running',
    vmid: 100, maxCpu: 2, maxMem: 4_000_000_000, maxDisk: 32_000_000_000, uptime: 800_000,
    storageType: null, storageContent: null, storageAvail: null, storageShared: null,
    clusterVersion: null,
    cpu: { base: 0.15, amplitude: 0.1, periodMs: 8 * MINUTE, noiseLevel: 0.05, min: 0.01, max: 0.8 },
    mem: { base: 2_500_000_000, amplitude: 500_000_000, periodMs: 20 * MINUTE, noiseLevel: 200_000_000, min: 1_000_000_000, max: 3_800_000_000 },
    disk: { base: 15_000_000_000, amplitude: 2_000_000_000, periodMs: HOUR, noiseLevel: 500_000_000, min: 5_000_000_000, max: 30_000_000_000 },
    netin: { base: 200_000, amplitude: 150_000, periodMs: 5 * MINUTE, noiseLevel: 80_000, min: 1_000, max: 1_000_000 },
    netout: { base: 150_000, amplitude: 100_000, periodMs: 5 * MINUTE, noiseLevel: 60_000, min: 1_000, max: 800_000 },
  },
  {
    entityType: 'qemu', host: PROXMOX_HOST, node: 'pve1',
    entityId: '101', entityName: 'windows-desktop', status: 'running',
    vmid: 101, maxCpu: 4, maxMem: 8_000_000_000, maxDisk: 128_000_000_000, uptime: 400_000,
    storageType: null, storageContent: null, storageAvail: null, storageShared: null,
    clusterVersion: null,
    cpu: { base: 0.3, amplitude: 0.2, periodMs: 6 * MINUTE, noiseLevel: 0.1, min: 0.02, max: 0.95 },
    mem: { base: 5_500_000_000, amplitude: 1_000_000_000, periodMs: 15 * MINUTE, noiseLevel: 400_000_000, min: 3_000_000_000, max: 7_800_000_000 },
    disk: { base: 60_000_000_000, amplitude: 10_000_000_000, periodMs: HOUR, noiseLevel: 3_000_000_000, min: 20_000_000_000, max: 120_000_000_000 },
    netin: { base: 500_000, amplitude: 400_000, periodMs: 5 * MINUTE, noiseLevel: 200_000, min: 5_000, max: 3_000_000 },
    netout: { base: 300_000, amplitude: 200_000, periodMs: 5 * MINUTE, noiseLevel: 100_000, min: 2_000, max: 2_000_000 },
  },

  // ── LXC Containers ─────────────────────────────────────────────────────────
  {
    entityType: 'lxc', host: PROXMOX_HOST, node: 'pve2',
    entityId: '200', entityName: 'pihole-ct', status: 'running',
    vmid: 200, maxCpu: 1, maxMem: 512_000_000, maxDisk: 8_000_000_000, uptime: 1_100_000,
    storageType: null, storageContent: null, storageAvail: null, storageShared: null,
    clusterVersion: null,
    cpu: { base: 0.05, amplitude: 0.03, periodMs: 10 * MINUTE, noiseLevel: 0.02, min: 0.005, max: 0.3 },
    mem: { base: 200_000_000, amplitude: 50_000_000, periodMs: HOUR, noiseLevel: 20_000_000, min: 100_000_000, max: 480_000_000 },
    disk: { base: 2_000_000_000, amplitude: 200_000_000, periodMs: HOUR, noiseLevel: 50_000_000, min: 500_000_000, max: 7_000_000_000 },
    netin: { base: 20_000, amplitude: 15_000, periodMs: 5 * MINUTE, noiseLevel: 8_000, min: 500, max: 100_000 },
    netout: { base: 15_000, amplitude: 10_000, periodMs: 5 * MINUTE, noiseLevel: 5_000, min: 500, max: 80_000 },
  },
  {
    entityType: 'lxc', host: PROXMOX_HOST, node: 'pve2',
    entityId: '201', entityName: 'docker-ct', status: 'running',
    vmid: 201, maxCpu: 2, maxMem: 4_000_000_000, maxDisk: 50_000_000_000, uptime: 1_000_000,
    storageType: null, storageContent: null, storageAvail: null, storageShared: null,
    clusterVersion: null,
    cpu: { base: 0.2, amplitude: 0.15, periodMs: 8 * MINUTE, noiseLevel: 0.06, min: 0.01, max: 0.85 },
    mem: { base: 2_500_000_000, amplitude: 600_000_000, periodMs: 20 * MINUTE, noiseLevel: 250_000_000, min: 800_000_000, max: 3_800_000_000 },
    disk: { base: 20_000_000_000, amplitude: 5_000_000_000, periodMs: HOUR, noiseLevel: 1_500_000_000, min: 5_000_000_000, max: 45_000_000_000 },
    netin: { base: 400_000, amplitude: 300_000, periodMs: 5 * MINUTE, noiseLevel: 150_000, min: 5_000, max: 2_000_000 },
    netout: { base: 350_000, amplitude: 250_000, periodMs: 5 * MINUTE, noiseLevel: 120_000, min: 3_000, max: 1_500_000 },
  },

  // ── Storages ───────────────────────────────────────────────────────────────
  {
    entityType: 'storage', host: PROXMOX_HOST, node: 'pve1',
    entityId: 'pve1/local', entityName: 'local', status: 'active',
    vmid: null, maxCpu: null, maxMem: null, maxDisk: 100_000_000_000, uptime: 0,
    storageType: 'dir', storageContent: 'iso,vztmpl,backup', storageAvail: 60_000_000_000, storageShared: false,
    clusterVersion: null,
    cpu: null, mem: null,
    disk: { base: 40_000_000_000, amplitude: 5_000_000_000, periodMs: HOUR, noiseLevel: 1_000_000_000, min: 10_000_000_000, max: 90_000_000_000 },
    netin: null, netout: null,
  },
  {
    entityType: 'storage', host: PROXMOX_HOST, node: 'pve1',
    entityId: 'pve1/nfs-share', entityName: 'nfs-share', status: 'active',
    vmid: null, maxCpu: null, maxMem: null, maxDisk: 2_000_000_000_000, uptime: 0,
    storageType: 'nfs', storageContent: 'images,rootdir,backup', storageAvail: 1_200_000_000_000, storageShared: true,
    clusterVersion: null,
    cpu: null, mem: null,
    disk: { base: 800_000_000_000, amplitude: 50_000_000_000, periodMs: HOUR, noiseLevel: 20_000_000_000, min: 200_000_000_000, max: 1_800_000_000_000 },
    netin: null, netout: null,
  },
  {
    entityType: 'storage', host: PROXMOX_HOST, node: 'pve2',
    entityId: 'pve2/local', entityName: 'local', status: 'active',
    vmid: null, maxCpu: null, maxMem: null, maxDisk: 100_000_000_000, uptime: 0,
    storageType: 'dir', storageContent: 'iso,vztmpl,backup', storageAvail: 70_000_000_000, storageShared: false,
    clusterVersion: null,
    cpu: null, mem: null,
    disk: { base: 30_000_000_000, amplitude: 4_000_000_000, periodMs: HOUR, noiseLevel: 1_000_000_000, min: 5_000_000_000, max: 90_000_000_000 },
    netin: null, netout: null,
  },
];

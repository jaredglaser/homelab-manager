import type { MetricProfile, ActivityProfile, SimplexProfile } from '@/lib/mock/patterns';

// ─── Docker Entities ─────────────────────────────────────────────────────────

export interface DockerEntityDef {
  host: string;
  hostName: string;
  containerId: string;
  containerName: string;
  image: string;
  iconSlug: string;
  serviceKey: string;
  cpu: SimplexProfile;
  memoryUsage: SimplexProfile;
  memoryLimit: number;
  networkRx: SimplexProfile;
  networkTx: SimplexProfile;
  blockRead: SimplexProfile;
  blockWrite: SimplexProfile;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;

export const DOCKER_ENTITIES: DockerEntityDef[] = [
  // ── nas01 ──────────────────────────────────────────────────────────────────
  {
    // nginx-proxy: low CPU, stable memory, bursty network
    host: '192.168.1.10',
    hostName: 'nas01',
    containerId: 'a1b2c3d4e5f6',
    containerName: 'nginx-proxy',
    image: 'nginx:latest',
    iconSlug: 'nginx',
    serviceKey: 'nginx-proxy',
    cpu: { base: 5, amplitude: 3, periods: [12 * MINUTE, 2.5 * MINUTE, 28_000, 8_000], min: 0.5, max: 15 },
    memoryUsage: { base: 150_000_000, amplitude: 20_000_000, periods: [2.5 * HOUR, 45 * MINUTE, 14 * MINUTE, 5 * MINUTE], min: 100_000_000, max: 400_000_000 },
    memoryLimit: 512_000_000,
    networkRx: { base: 500_000, amplitude: 300_000, periods: [10 * MINUTE, 2 * MINUTE, 30_000, 8_000], min: 10_000, max: 2_000_000 },
    networkTx: { base: 800_000, amplitude: 400_000, periods: [10 * MINUTE, 2.5 * MINUTE, 35_000, 9_000], min: 10_000, max: 3_000_000 },
    blockRead: { base: 50_000, amplitude: 30_000, periods: [30 * MINUTE, 7 * MINUTE, 70_000, 18_000], min: 0, max: 500_000 },
    blockWrite: { base: 20_000, amplitude: 10_000, periods: [35 * MINUTE, 8 * MINUTE, 75_000, 20_000], min: 0, max: 200_000 },
  },
  {
    // plex: low idle CPU with big spikes, high stable memory, high tx/read bursts
    host: '192.168.1.10',
    hostName: 'nas01',
    containerId: 'b2c3d4e5f6a7',
    containerName: 'plex',
    image: 'plexinc/pms-docker:latest',
    iconSlug: 'plex',
    serviceKey: 'plex',
    cpu: { base: 15, amplitude: 20, periods: [9 * MINUTE, 2 * MINUTE, 25_000, 7_000], min: 2, max: 55 },
    memoryUsage: { base: 2_000_000_000, amplitude: 500_000_000, periods: [2 * HOUR, 50 * MINUTE, 18 * MINUTE, 6 * MINUTE], min: 1_000_000_000, max: 3_800_000_000 },
    memoryLimit: 4_000_000_000,
    networkRx: { base: 200_000, amplitude: 100_000, periods: [12 * MINUTE, 2.5 * MINUTE, 35_000, 10_000], min: 5_000, max: 1_000_000 },
    networkTx: { base: 5_000_000, amplitude: 4_000_000, periods: [9 * MINUTE, 1.8 * MINUTE, 28_000, 8_000], min: 50_000, max: 15_000_000 },
    blockRead: { base: 2_000_000, amplitude: 1_500_000, periods: [28 * MINUTE, 6 * MINUTE, 65_000, 16_000], min: 10_000, max: 8_000_000 },
    blockWrite: { base: 100_000, amplitude: 80_000, periods: [32 * MINUTE, 7 * MINUTE, 80_000, 19_000], min: 0, max: 1_000_000 },
  },
  {
    // homeassistant: very low steady CPU, stable memory, low steady network
    host: '192.168.1.10',
    hostName: 'nas01',
    containerId: 'c3d4e5f6a7b8',
    containerName: 'homeassistant',
    image: 'homeassistant/home-assistant:stable',
    iconSlug: 'home-assistant',
    serviceKey: 'homeassistant',
    cpu: { base: 4.5, amplitude: 1.5, periods: [18 * MINUTE, 4 * MINUTE, 50_000, 14_000], min: 1, max: 10 },
    memoryUsage: { base: 300_000_000, amplitude: 50_000_000, periods: [3 * HOUR, HOUR, 22 * MINUTE, 7 * MINUTE], min: 200_000_000, max: 500_000_000 },
    memoryLimit: 1_000_000_000,
    networkRx: { base: 50_000, amplitude: 30_000, periods: [13 * MINUTE, 3 * MINUTE, 40_000, 11_000], min: 1_000, max: 200_000 },
    networkTx: { base: 40_000, amplitude: 20_000, periods: [14 * MINUTE, 2.8 * MINUTE, 38_000, 10_000], min: 1_000, max: 150_000 },
    blockRead: { base: 30_000, amplitude: 15_000, periods: [35 * MINUTE, 9 * MINUTE, 85_000, 20_000], min: 0, max: 200_000 },
    blockWrite: { base: 80_000, amplitude: 40_000, periods: [38 * MINUTE, 10 * MINUTE, 90_000, 22_000], min: 0, max: 300_000 },
  },
  {
    // postgres: moderate fast CPU, high slow-drift memory, moderate correlated r/w
    host: '192.168.1.10',
    hostName: 'nas01',
    containerId: 'd4e5f6a7b8c9',
    containerName: 'postgres',
    image: 'timescale/timescaledb:latest-pg16',
    iconSlug: 'postgres',
    serviceKey: 'postgres',
    cpu: { base: 11, amplitude: 4, periods: [8 * MINUTE, 1.5 * MINUTE, 22_000, 6_000], min: 3, max: 25 },
    memoryUsage: { base: 1_500_000_000, amplitude: 300_000_000, periods: [2.2 * HOUR, 42 * MINUTE, 15 * MINUTE, 5.5 * MINUTE], min: 800_000_000, max: 3_500_000_000 },
    memoryLimit: 4_000_000_000,
    networkRx: { base: 300_000, amplitude: 200_000, periods: [9 * MINUTE, 2 * MINUTE, 32_000, 9_000], min: 10_000, max: 1_500_000 },
    networkTx: { base: 400_000, amplitude: 250_000, periods: [9 * MINUTE, 2.2 * MINUTE, 34_000, 10_000], min: 10_000, max: 2_000_000 },
    blockRead: { base: 1_000_000, amplitude: 800_000, periods: [25 * MINUTE, 5.5 * MINUTE, 60_000, 15_000], min: 10_000, max: 5_000_000 },
    blockWrite: { base: 500_000, amplitude: 400_000, periods: [27 * MINUTE, 6 * MINUTE, 65_000, 17_000], min: 10_000, max: 3_000_000 },
  },
  {
    // grafana: very low CPU, stable low memory, low network
    host: '192.168.1.10',
    hostName: 'nas01',
    containerId: 'e5f6a7b8c9d0',
    containerName: 'grafana',
    image: 'grafana/grafana:latest',
    iconSlug: 'grafana',
    serviceKey: 'grafana',
    cpu: { base: 2.5, amplitude: 1.5, periods: [20 * MINUTE, 5 * MINUTE, 55_000, 15_000], min: 0.5, max: 8 },
    memoryUsage: { base: 200_000_000, amplitude: 30_000_000, periods: [2.8 * HOUR, 55 * MINUTE, 20 * MINUTE, 7.5 * MINUTE], min: 120_000_000, max: 400_000_000 },
    memoryLimit: 512_000_000,
    networkRx: { base: 20_000, amplitude: 15_000, periods: [11 * MINUTE, 2.5 * MINUTE, 36_000, 10_000], min: 1_000, max: 100_000 },
    networkTx: { base: 30_000, amplitude: 20_000, periods: [12 * MINUTE, 2.8 * MINUTE, 40_000, 11_000], min: 1_000, max: 150_000 },
    blockRead: { base: 40_000, amplitude: 25_000, periods: [30 * MINUTE, 8 * MINUTE, 75_000, 18_000], min: 0, max: 200_000 },
    blockWrite: { base: 15_000, amplitude: 10_000, periods: [33 * MINUTE, 9 * MINUTE, 80_000, 20_000], min: 0, max: 100_000 },
  },
  {
    // traefik: low fast CPU, very stable low memory, bursty network
    host: '192.168.1.10',
    hostName: 'nas01',
    containerId: 'f6a7b8c9d0e1',
    containerName: 'traefik',
    image: 'traefik:v3',
    iconSlug: 'traefik',
    serviceKey: 'traefik',
    cpu: { base: 3, amplitude: 2, periods: [10 * MINUTE, 2 * MINUTE, 20_000, 6_000], min: 0.5, max: 10 },
    memoryUsage: { base: 100_000_000, amplitude: 15_000_000, periods: [2.6 * HOUR, 48 * MINUTE, 16 * MINUTE, 6 * MINUTE], min: 60_000_000, max: 200_000_000 },
    memoryLimit: 256_000_000,
    networkRx: { base: 1_200_000, amplitude: 800_000, periods: [8 * MINUTE, 1.5 * MINUTE, 22_000, 6_000], min: 50_000, max: 5_000_000 },
    networkTx: { base: 1_500_000, amplitude: 1_000_000, periods: [8 * MINUTE, 1.8 * MINUTE, 25_000, 7_000], min: 50_000, max: 6_000_000 },
    blockRead: { base: 5_000, amplitude: 3_000, periods: [40 * MINUTE, 10 * MINUTE, 85_000, 20_000], min: 0, max: 50_000 },
    blockWrite: { base: 10_000, amplitude: 5_000, periods: [38 * MINUTE, 9 * MINUTE, 80_000, 18_000], min: 0, max: 80_000 },
  },

  // ── server02 ───────────────────────────────────────────────────────────────
  {
    // jellyfin: low idle with big spikes (like plex), high memory, high tx bursts
    host: '192.168.1.20',
    hostName: 'server02',
    containerId: 'a7b8c9d0e1f2',
    containerName: 'jellyfin',
    image: 'jellyfin/jellyfin:latest',
    iconSlug: 'jellyfin',
    serviceKey: 'jellyfin',
    cpu: { base: 25, amplitude: 25, periods: [11 * MINUTE, 2.5 * MINUTE, 30_000, 8_000], min: 3, max: 70 },
    memoryUsage: { base: 3_000_000_000, amplitude: 1_000_000_000, periods: [2.3 * HOUR, 48 * MINUTE, 16 * MINUTE, 5.5 * MINUTE], min: 1_500_000_000, max: 7_500_000_000 },
    memoryLimit: 8_000_000_000,
    networkRx: { base: 100_000, amplitude: 80_000, periods: [11 * MINUTE, 2.2 * MINUTE, 32_000, 9_000], min: 5_000, max: 500_000 },
    networkTx: { base: 8_000_000, amplitude: 6_000_000, periods: [10 * MINUTE, 2 * MINUTE, 28_000, 7_000], min: 50_000, max: 25_000_000 },
    blockRead: { base: 3_000_000, amplitude: 2_500_000, periods: [26 * MINUTE, 5 * MINUTE, 62_000, 15_000], min: 20_000, max: 12_000_000 },
    blockWrite: { base: 200_000, amplitude: 150_000, periods: [30 * MINUTE, 7 * MINUTE, 78_000, 19_000], min: 0, max: 1_500_000 },
  },
  {
    // vaultwarden: very low everything
    host: '192.168.1.20',
    hostName: 'server02',
    containerId: 'b8c9d0e1f2a3',
    containerName: 'vaultwarden',
    image: 'vaultwarden/server:latest',
    iconSlug: 'vaultwarden',
    serviceKey: 'vaultwarden',
    cpu: { base: 2, amplitude: 1.5, periods: [17 * MINUTE, 4.5 * MINUTE, 55_000, 14_000], min: 0.3, max: 8 },
    memoryUsage: { base: 120_000_000, amplitude: 20_000_000, periods: [3 * HOUR, HOUR, 25 * MINUTE, 8 * MINUTE], min: 80_000_000, max: 300_000_000 },
    memoryLimit: 512_000_000,
    networkRx: { base: 5_000, amplitude: 3_000, periods: [15 * MINUTE, 3 * MINUTE, 45_000, 13_000], min: 500, max: 30_000 },
    networkTx: { base: 8_000, amplitude: 5_000, periods: [14 * MINUTE, 2.8 * MINUTE, 42_000, 12_000], min: 500, max: 50_000 },
    blockRead: { base: 5_000, amplitude: 3_000, periods: [35 * MINUTE, 8 * MINUTE, 80_000, 20_000], min: 0, max: 30_000 },
    blockWrite: { base: 10_000, amplitude: 8_000, periods: [38 * MINUTE, 9 * MINUTE, 85_000, 22_000], min: 0, max: 80_000 },
  },
  {
    // pihole: very low fast CPU, very stable low memory, steady low network
    host: '192.168.1.20',
    hostName: 'server02',
    containerId: 'c9d0e1f2a3b4',
    containerName: 'pihole',
    image: 'pihole/pihole:latest',
    iconSlug: 'pi-hole',
    serviceKey: 'pihole',
    cpu: { base: 1.2, amplitude: 0.8, periods: [9 * MINUTE, 1.8 * MINUTE, 24_000, 7_000], min: 0.2, max: 4 },
    memoryUsage: { base: 80_000_000, amplitude: 10_000_000, periods: [2.7 * HOUR, 52 * MINUTE, 19 * MINUTE, 7 * MINUTE], min: 50_000_000, max: 150_000_000 },
    memoryLimit: 256_000_000,
    networkRx: { base: 15_000, amplitude: 10_000, periods: [10 * MINUTE, 2.2 * MINUTE, 30_000, 8_000], min: 1_000, max: 80_000 },
    networkTx: { base: 12_000, amplitude: 8_000, periods: [10 * MINUTE, 2.5 * MINUTE, 33_000, 9_000], min: 1_000, max: 60_000 },
    blockRead: { base: 2_000, amplitude: 1_500, periods: [32 * MINUTE, 7 * MINUTE, 72_000, 17_000], min: 0, max: 15_000 },
    blockWrite: { base: 3_000, amplitude: 2_000, periods: [34 * MINUTE, 8 * MINUTE, 78_000, 19_000], min: 0, max: 20_000 },
  },
  {
    // portainer: very low everything
    host: '192.168.1.20',
    hostName: 'server02',
    containerId: 'd0e1f2a3b4c5',
    containerName: 'portainer',
    image: 'portainer/portainer-ce:latest',
    iconSlug: 'portainer',
    serviceKey: 'portainer',
    cpu: { base: 1.5, amplitude: 1, periods: [15 * MINUTE, 3.5 * MINUTE, 45_000, 12_000], min: 0.2, max: 5 },
    memoryUsage: { base: 50_000_000, amplitude: 10_000_000, periods: [2.5 * HOUR, 50 * MINUTE, 18 * MINUTE, 6.5 * MINUTE], min: 30_000_000, max: 120_000_000 },
    memoryLimit: 128_000_000,
    networkRx: { base: 3_000, amplitude: 2_000, periods: [12 * MINUTE, 2.8 * MINUTE, 38_000, 11_000], min: 200, max: 20_000 },
    networkTx: { base: 5_000, amplitude: 3_000, periods: [13 * MINUTE, 3 * MINUTE, 42_000, 12_000], min: 200, max: 30_000 },
    blockRead: { base: 3_000, amplitude: 2_000, periods: [36 * MINUTE, 8 * MINUTE, 76_000, 18_000], min: 0, max: 20_000 },
    blockWrite: { base: 2_000, amplitude: 1_500, periods: [34 * MINUTE, 7 * MINUTE, 72_000, 17_000], min: 0, max: 15_000 },
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
  /** Activity-based I/O profile - replaces per-metric sine-wave profiles. */
  activity: ActivityProfile;
}

// ── application pool (2x NVMe mirror, ~3 TiB - VM/LXC storage) ──────────────
//
// NVMe characteristics: fast random I/O (VMs doing DB work = high IOPS / med BW)
// and high sequential throughput (VM migrations / large file copies = high BW / low IOPS).
// Mirror read policy: both disks serve reads (~50% each), both receive all writes (100%).
//
// State breakdown:
//   idle - no activity                          (30%)
//   low  - background metadata, cache warming   (28%)
//   med  - VM random I/O: high IOPS / med BW    (27%)
//   high - sequential: VM migration / large IO  (15%)
const APP_POOL_ACTIVITY: ActivityProfile = {
  stateDurationMs: 45_000,
  weights: [0.30, 0.28, 0.27, 0.15],
  noise: 0.14,
  transitionMs: 0,       // NVMe: instant step - no ramp-up
  idleBlipScale: 0.25,   // ARC metadata reads, cache warm-up blips
  idle: { readBytes: 0,             writeBytes: 0,           readOps: 0,      writeOps: 0      },
  low:  { readBytes: 5_000_000,     writeBytes: 2_000_000,   readOps: 450,    writeOps: 180    },
  med:  { readBytes: 130_000_000,   writeBytes: 65_000_000,  readOps: 22_000, writeOps: 11_000 },
  high: { readBytes: 1_400_000_000, writeBytes: 420_000_000, readOps: 1_200,  writeOps: 360    },
};
// Mirror disks: reads split ~50/50, writes go to both (100% of pool writes)
const APP_DISK_ACTIVITY: ActivityProfile = {
  ...APP_POOL_ACTIVITY,  // inherits transitionMs: 0
  idle: { readBytes: 0,           writeBytes: 0,           readOps: 0,      writeOps: 0      },
  low:  { readBytes: 2_500_000,   writeBytes: 2_000_000,   readOps: 225,    writeOps: 180    },
  med:  { readBytes: 65_000_000,  writeBytes: 65_000_000,  readOps: 11_000, writeOps: 11_000 },
  high: { readBytes: 700_000_000, writeBytes: 420_000_000, readOps: 600,    writeOps: 360    },
};

// ── rust pool (8x HDD raidz2, ~48 TiB - bulk media) ─────────────────────────
//
// HDD characteristics: slow random I/O, good sequential throughput.
// raidz2 with 8 drives: ~600 MB/s sequential, ~350 IOPS random pool-level.
// Primary workload: Plex/Jellyfin streaming = high sequential read, low IOPS.
//
// State breakdown:
//   idle - pool at rest (overnight, low demand)  (42%)
//   low  - metadata reads, background scrub      (33%)
//   med  - Sonarr/Radarr activity, random seeks  (17%)
//   high - active media streaming (sequential)    (8%)
const RUST_POOL_ACTIVITY: ActivityProfile = {
  stateDurationMs: 60_000,
  weights: [0.42, 0.33, 0.17, 0.08],
  noise: 0.12,
  transitionMs: 3_000,   // HDD: ~3 seconds to spin up / settle
  idleBlipScale: 0.20,   // occasional background scrub, ZIL flush blips
  idle: { readBytes: 0,           writeBytes: 0,          readOps: 0,   writeOps: 0  },
  low:  { readBytes: 1_000_000,   writeBytes: 300_000,    readOps: 15,  writeOps: 5  },
  med:  { readBytes: 55_000_000,  writeBytes: 35_000_000, readOps: 550, writeOps: 220 },
  high: { readBytes: 580_000_000, writeBytes: 8_000_000,  readOps: 300, writeOps: 25  },
};
// raidz2 disks: each drive carries ~1/8 of pool I/O (striped evenly across all 8 drives)
const RUST_DISK_ACTIVITY: ActivityProfile = {
  ...RUST_POOL_ACTIVITY,  // inherits transitionMs: 3_000
  idle: { readBytes: 0,          writeBytes: 0,         readOps: 0,  writeOps: 0 },
  low:  { readBytes: 125_000,    writeBytes: 38_000,    readOps: 2,  writeOps: 1 },
  med:  { readBytes: 6_900_000,  writeBytes: 4_400_000, readOps: 69, writeOps: 28 },
  high: { readBytes: 72_500_000, writeBytes: 1_000_000, readOps: 38, writeOps: 3  },
};

// ── system pool (single SSD, ~500 GiB - host OS) ─────────────────────────────
//
// Light, bursty OS workload: mostly idle with occasional reads (package updates,
// logs) and small writes. sda is the only child entity (depth-1) with no disk
// children → triggers isSingleDiskPool=true → shows "single disk" badge.
//
// State breakdown:
//   idle - OS idle, no disk activity             (55%)
//   low  - log flushes, inode updates            (30%)
//   med  - apt/pacman update, service restart    (12%)
//   high - OS install, large config write         (3%)
const SYSTEM_ACTIVITY: ActivityProfile = {
  stateDurationMs: 60_000,
  weights: [0.55, 0.30, 0.12, 0.03],
  noise: 0.20,
  transitionMs: 1_000,   // SSD: ~1 second ramp
  idleBlipScale: 0.30,   // OS idle is noisy: journald, cron, inode updates
  idle: { readBytes: 0,          writeBytes: 0,         readOps: 0,   writeOps: 0   },
  low:  { readBytes: 200_000,    writeBytes: 80_000,    readOps: 12,  writeOps: 5   },
  med:  { readBytes: 8_000_000,  writeBytes: 3_000_000, readOps: 180, writeOps: 80  },
  high: { readBytes: 40_000_000, writeBytes: 8_000_000, readOps: 380, writeOps: 150 },
};

export const ZFS_ENTITIES: ZFSEntityDef[] = [
  // ── application pool ──────────────────────────────────────────────────────
  // Entity paths use slashes so buildHierarchyFromRows places them correctly:
  //   depth 0 (no '/')  → pool
  //   depth 1 (one '/') → vdev
  //   depth 2+ (2+ '/') → disk
  { host: 'nas01', pool: 'application', entity: 'application',              entityType: 'pool', indent: 0, capacityAlloc: 1_800_000_000_000, capacityFree: 1_200_000_000_000, activity: APP_POOL_ACTIVITY },
  { host: 'nas01', pool: 'application', entity: 'application/mirror-0',     entityType: 'vdev', indent: 2, capacityAlloc: 1_800_000_000_000, capacityFree: 1_200_000_000_000, activity: APP_POOL_ACTIVITY },
  { host: 'nas01', pool: 'application', entity: 'application/mirror-0/nvme0n1', entityType: 'disk', indent: 4, capacityAlloc: 0, capacityFree: 0, activity: APP_DISK_ACTIVITY },
  { host: 'nas01', pool: 'application', entity: 'application/mirror-0/nvme1n1', entityType: 'disk', indent: 4, capacityAlloc: 0, capacityFree: 0, activity: APP_DISK_ACTIVITY },

  // ── rust pool ─────────────────────────────────────────────────────────────
  { host: 'nas01', pool: 'rust', entity: 'rust',          entityType: 'pool', indent: 0, capacityAlloc: 33_600_000_000_000, capacityFree: 14_400_000_000_000, activity: RUST_POOL_ACTIVITY },
  { host: 'nas01', pool: 'rust', entity: 'rust/raidz2-0', entityType: 'vdev', indent: 2, capacityAlloc: 33_600_000_000_000, capacityFree: 14_400_000_000_000, activity: RUST_POOL_ACTIVITY },
  // 8 drives - each carries ~1/8 of pool I/O
  ...(['sdc', 'sdd', 'sde', 'sdf', 'sdg', 'sdh', 'sdi', 'sdj'] as const).map((disk): ZFSEntityDef => ({
    host: 'nas01', pool: 'rust', entity: `rust/raidz2-0/${disk}`, entityType: 'disk', indent: 4,
    capacityAlloc: 0, capacityFree: 0, activity: RUST_DISK_ACTIVITY,
  })),

  // ── system pool ───────────────────────────────────────────────────────────
  // sda is the only child with a depth-1 entity path and no disk children
  // → isSingleDiskPool=true → shows "single disk" badge, pool is non-expandable
  { host: 'nas01', pool: 'system', entity: 'system',     entityType: 'pool', indent: 0, capacityAlloc: 256_000_000_000, capacityFree: 244_000_000_000, activity: SYSTEM_ACTIVITY },
  { host: 'nas01', pool: 'system', entity: 'system/sda', entityType: 'vdev', indent: 2, capacityAlloc: 256_000_000_000, capacityFree: 244_000_000_000, activity: SYSTEM_ACTIVITY },
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

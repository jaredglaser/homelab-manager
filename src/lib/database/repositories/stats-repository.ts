import type { Pool } from 'pg';
import type { DockerStatsRow } from '@/types/docker';
import { isProxmoxEntityType, type ProxmoxStatsRow } from '@/types/proxmox';
import type { ZFSStatsRow } from '@/types/zfs';
import { parseRowEnum } from '@/lib/database/repositories/row-enum';

/** Insert shape for proxmox_stats: same as the read row, but `time` stays a Date for the timestamptz bind. */
export type NewProxmoxStat = Omit<ProxmoxStatsRow, 'time'> & { time: Date };

/** Domain shape docker collectors emit; no `docker_stats` column knowledge. */
export interface NewDockerStat {
  time: Date;
  host: string;
  containerId: string;
  containerName: string | null;
  image: string | null;
  cpuPercent: number | null;
  memoryUsage: number | null;
  memoryLimit: number | null;
  memoryPercent: number | null;
  networkRxBytesPerSec: number | null;
  networkTxBytesPerSec: number | null;
  blockReadBytesPerSec: number | null;
  blockWriteBytesPerSec: number | null;
}

/** Domain shape the ZFS collector emits; no `zfs_stats` column knowledge. */
export interface NewZFSStat {
  time: Date;
  host: string;
  pool: string;
  entity: string;
  entityType: string;
  indent: number;
  capacityAlloc: number;
  capacityFree: number;
  readOpsPerSec: number;
  writeOpsPerSec: number;
  readBytesPerSec: number;
  writeBytesPerSec: number;
}

export type StatsSourceTable = 'docker_stats' | 'zfs_stats' | 'proxmox_stats';

/** Every numeric field is a number because the queries cast the BIGINT columns to float8. */
interface DockerStatsQueryRow {
  time: Date;
  host: string;
  container_id: string;
  container_name: string | null;
  image: string | null;
  cpu_percent: number | null;
  memory_usage: number | null;
  memory_limit: number | null;
  memory_percent: number | null;
  network_rx_bytes_per_sec: number | null;
  network_tx_bytes_per_sec: number | null;
  block_io_read_bytes_per_sec: number | null;
  block_io_write_bytes_per_sec: number | null;
}

interface ZFSStatsQueryRow {
  time: Date;
  host: string;
  pool: string;
  entity: string;
  entity_type: string;
  indent: number;
  capacity_alloc: number | null;
  capacity_free: number | null;
  read_ops_per_sec: number | null;
  write_ops_per_sec: number | null;
  read_bytes_per_sec: number | null;
  write_bytes_per_sec: number | null;
  utilization_percent: number | null;
}

/** A proxmox_stats row from any tier; the SQL casts the BIGINT/numeric columns to float8. */
interface ProxmoxStatsQueryRow {
  time: Date;
  host: string;
  entity_type: string;
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

// eslint-disable-next-line local/no-overwide-union -- pg accepts text, a Date, a number and an array as bound parameters
type PgParam = string | Date | number | string[];

/** The single-column bounds projection getDockerStatsForContainer selects. */
interface ActualSpanRow {
  actual_span_secs: number | null;
}

export interface StatsTier {
  relation: string;
  minBucketSeconds: number;
}

/** Longest window worth reading off raw before the row count gets out of hand. */
export const RAW_TIER_MAX_SECONDS = 30 * 60;
/** Longest window worth reading off the 1-minute aggregate. */
export const MINUTE_TIER_MAX_SECONDS = 2 * 24 * 60 * 60;

/** Retention of each tier, which bounds how far back it can be read at all. */
const RAW_RETENTION_SECONDS = 24 * 60 * 60;
const MINUTE_RETENTION_SECONDS = 30 * 24 * 60 * 60;

const TIER_SUFFIXES = ['', '_1m', '_1h_avg'];
const TIER_MIN_BUCKET_SECONDS = [1, 60, 3600];

function tierByVolume(windowSeconds: number): number {
  if (windowSeconds <= RAW_TIER_MAX_SECONDS) return 0;
  if (windowSeconds <= MINUTE_TIER_MAX_SECONDS) return 1;
  return 2;
}

function tierByAvailability(windowStartAgeSeconds: number): number {
  if (windowStartAgeSeconds < RAW_RETENTION_SECONDS) return 0;
  if (windowStartAgeSeconds <= MINUTE_RETENTION_SECONDS) return 1;
  return 2;
}

/**
 * Pick a tier that can serve the window on both counts, taking whichever is coarser.
 * Span alone is not enough: a one-hour window panned three months back is small but its
 * data only exists in the hourly tier, and routing it to raw renders an empty chart.
 * Age alone is not enough either, since a month-long window ending now would be read a
 * second at a time off raw.
 *
 * @param windowSeconds length of the requested window
 * @param windowStartAgeSeconds how long ago the window starts; defaults to `windowSeconds`
 *   for the callers whose window ends at now
 */
export function resolveStatsTier(
  table: StatsSourceTable,
  windowSeconds: number,
  windowStartAgeSeconds: number = windowSeconds,
): StatsTier {
  const level = Math.max(tierByVolume(windowSeconds), tierByAvailability(windowStartAgeSeconds));
  return {
    relation: `${table}${TIER_SUFFIXES[level]}`,
    minBucketSeconds: TIER_MIN_BUCKET_SECONDS[level],
  };
}

/**
 * Target ~300 data points per entity, floored at the tier's own resolution: bucketing an
 * hourly aggregate into 6-second buckets would just repeat each row 600 times.
 */
function tierBucketSeconds(tier: StatsTier, windowSeconds: number, targetPoints = 300): number {
  return Math.max(tier.minBucketSeconds, Math.ceil(windowSeconds / targetPoints));
}

export class StatsRepository {
  constructor(private pool: Pool) {}

  async insertDockerStats(rows: NewDockerStat[]): Promise<void> {
    if (rows.length === 0) return;

    try {
      const times: Date[] = [];
      const hosts: string[] = [];
      const containerIds: string[] = [];
      const containerNames: (string | null)[] = [];
      const images: (string | null)[] = [];
      const cpuPercents: (number | null)[] = [];
      const memoryUsages: (number | null)[] = [];
      const memoryLimits: (number | null)[] = [];
      const memoryPercents: (number | null)[] = [];
      const networkRx: (number | null)[] = [];
      const networkTx: (number | null)[] = [];
      const blockRead: (number | null)[] = [];
      const blockWrite: (number | null)[] = [];

      for (const row of rows) {
        times.push(row.time);
        hosts.push(row.host);
        containerIds.push(row.containerId);
        containerNames.push(row.containerName);
        images.push(row.image);
        cpuPercents.push(row.cpuPercent);
        memoryUsages.push(row.memoryUsage);
        memoryLimits.push(row.memoryLimit);
        memoryPercents.push(row.memoryPercent);
        networkRx.push(row.networkRxBytesPerSec);
        networkTx.push(row.networkTxBytesPerSec);
        blockRead.push(row.blockReadBytesPerSec);
        blockWrite.push(row.blockWriteBytesPerSec);
      }

      await this.pool.query(
        `INSERT INTO docker_stats (
          time, host, container_id, container_name, image,
          cpu_percent, memory_usage, memory_limit, memory_percent,
          network_rx_bytes_per_sec, network_tx_bytes_per_sec,
          block_io_read_bytes_per_sec, block_io_write_bytes_per_sec
        )
        SELECT * FROM unnest(
          $1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::text[],
          $6::float8[], $7::bigint[], $8::bigint[], $9::float8[],
          $10::float8[], $11::float8[], $12::float8[], $13::float8[]
        )`,
        [
          times, hosts, containerIds, containerNames, images,
          cpuPercents, memoryUsages, memoryLimits, memoryPercents,
          networkRx, networkTx, blockRead, blockWrite,
        ]
      );
    } catch (err) {
      console.error('[StatsRepository] Failed to insert docker stats:', err);
      throw err;
    }
  }

  async insertZFSStats(rows: NewZFSStat[]): Promise<void> {
    if (rows.length === 0) return;

    try {
      const times: Date[] = [];
      const hosts: string[] = [];
      const pools: string[] = [];
      const entities: string[] = [];
      const entityTypes: string[] = [];
      const indents: number[] = [];
      const capacityAllocs: number[] = [];
      const capacityFrees: number[] = [];
      const readOps: number[] = [];
      const writeOps: number[] = [];
      const readBytes: number[] = [];
      const writeBytes: number[] = [];
      const utilizations: number[] = [];

      for (const row of rows) {
        times.push(row.time);
        hosts.push(row.host);
        pools.push(row.pool);
        entities.push(row.entity);
        entityTypes.push(row.entityType);
        indents.push(row.indent);
        // capacity_alloc/capacity_free are bigint columns; truncate before insert.
        capacityAllocs.push(Math.trunc(row.capacityAlloc));
        capacityFrees.push(Math.trunc(row.capacityFree));
        readOps.push(row.readOpsPerSec);
        writeOps.push(row.writeOpsPerSec);
        readBytes.push(row.readBytesPerSec);
        writeBytes.push(row.writeBytesPerSec);
        // zpool iostat values are already per-second; utilization is the only derived value.
        const totalCapacity = row.capacityAlloc + row.capacityFree;
        utilizations.push(totalCapacity > 0 ? (row.capacityAlloc / totalCapacity) * 100 : 0);
      }

      await this.pool.query(
        `INSERT INTO zfs_stats (
          time, host, pool, entity, entity_type, indent,
          capacity_alloc, capacity_free,
          read_ops_per_sec, write_ops_per_sec,
          read_bytes_per_sec, write_bytes_per_sec,
          utilization_percent
        )
        SELECT * FROM unnest(
          $1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[],
          $7::bigint[], $8::bigint[],
          $9::float8[], $10::float8[],
          $11::float8[], $12::float8[],
          $13::float8[]
        )`,
        [
          times, hosts, pools, entities, entityTypes, indents,
          capacityAllocs, capacityFrees,
          readOps, writeOps,
          readBytes, writeBytes,
          utilizations,
        ]
      );
    } catch (err) {
      console.error('[StatsRepository] Failed to insert zfs stats:', err);
      throw err;
    }
  }

  async getDockerStatsSince(since: Date): Promise<DockerStatsRow[]> {
    const result = await this.pool.query<DockerStatsQueryRow>(
      `SELECT
         time, host, container_id, container_name, image,
         cpu_percent, memory_percent,
         memory_usage::float8 AS memory_usage,
         memory_limit::float8 AS memory_limit,
         network_rx_bytes_per_sec, network_tx_bytes_per_sec,
         block_io_read_bytes_per_sec, block_io_write_bytes_per_sec
       FROM docker_stats WHERE time > $1 ORDER BY time ASC`,
      [since]
    );
    return result.rows.map(toDockerStatsRow);
  }

  async getZFSStatsSince(since: Date): Promise<ZFSStatsRow[]> {
    const result = await this.pool.query<ZFSStatsQueryRow>(
      `SELECT
         time, host, pool, entity, entity_type, indent,
         capacity_alloc::float8 AS capacity_alloc,
         capacity_free::float8  AS capacity_free,
         read_ops_per_sec, write_ops_per_sec, read_bytes_per_sec, write_bytes_per_sec,
         utilization_percent
       FROM zfs_stats WHERE time > $1 ORDER BY time ASC`,
      [since]
    );
    return result.rows.map(toZFSStatsRow);
  }

  async getDockerStatsHistory(seconds: number): Promise<DockerStatsRow[]> {
    const tier = resolveStatsTier('docker_stats', seconds);
    const bucketSeconds = tierBucketSeconds(tier, seconds);
    const result = await this.pool.query<DockerStatsQueryRow>(
      `SELECT
         time_bucket(make_interval(secs => $2), time) AS time,
         host,
         container_id,
         last(container_name, time)              AS container_name,
         last(image, time)                       AS image,
         AVG(cpu_percent)                        AS cpu_percent,
         AVG(memory_usage)::float8               AS memory_usage,
         AVG(memory_limit)::float8               AS memory_limit,
         AVG(memory_percent)                     AS memory_percent,
         AVG(network_rx_bytes_per_sec)           AS network_rx_bytes_per_sec,
         AVG(network_tx_bytes_per_sec)           AS network_tx_bytes_per_sec,
         AVG(block_io_read_bytes_per_sec)        AS block_io_read_bytes_per_sec,
         AVG(block_io_write_bytes_per_sec)       AS block_io_write_bytes_per_sec
       FROM ${tier.relation}
       WHERE time > NOW() - make_interval(secs => $1)
       GROUP BY time_bucket(make_interval(secs => $2), time), host, container_id
       ORDER BY time ASC`,
      [seconds, bucketSeconds]
    );
    return result.rows.map(toDockerStatsRow);
  }

  /**
   * Query historical stats for one or more container IDs, returning a unified time series.
   * When multiple IDs are supplied (a service group), rows are merged by time bucket so
   * the caller receives a single continuous series spanning all container incarnations.
   */
  async getDockerStatsForContainer(
    containerIds: string[],
    host: string | undefined,
    from: Date,
    to: Date,
    targetPoints = 300,
  ): Promise<DockerStatsRow[]> {
    const requestedSpanSecs = (to.getTime() - from.getTime()) / 1000;
    const windowStartAgeSecs = Math.max(0, (Date.now() - from.getTime()) / 1000);
    const tier = resolveStatsTier('docker_stats', requestedSpanSecs, windowStartAgeSecs);

    // Find the actual data extent so we bucket based on real data density
    // rather than the full requested range. This prevents low-resolution graphs
    // when the requested range exceeds the available data.
    const boundsParams: PgParam[] = [from, to, containerIds];
    const boundsHostFilter = host ? `AND host = $${boundsParams.push(host)}` : '';

    const boundsResult = await this.pool.query<ActualSpanRow>(
      `SELECT EXTRACT(EPOCH FROM (MAX(time) - MIN(time)))::float8 AS actual_span_secs
       FROM ${tier.relation}
       WHERE time >= $1 AND time <= $2
         AND container_id = ANY($3)
         ${boundsHostFilter}`,
      boundsParams
    );

    const actualSpanSecs = boundsResult.rows[0]?.actual_span_secs ?? 0;
    const effectiveSpan = actualSpanSecs > 0
      ? Math.min(actualSpanSecs, requestedSpanSecs)
      : requestedSpanSecs;
    const bucketSeconds = tierBucketSeconds(tier, effectiveSpan, targetPoints);

    const params: PgParam[] = [from, to, bucketSeconds, containerIds];
    const hostFilter = host ? `AND host = $${params.push(host)}` : '';

    const result = await this.pool.query<DockerStatsQueryRow>(
      `SELECT
         time_bucket(make_interval(secs => $3), time) AS time,
         host,
         last(container_id, time)                AS container_id,
         last(container_name, time)              AS container_name,
         last(image, time)                       AS image,
         AVG(cpu_percent)                        AS cpu_percent,
         AVG(memory_usage)::float8               AS memory_usage,
         AVG(memory_limit)::float8               AS memory_limit,
         AVG(memory_percent)                     AS memory_percent,
         AVG(network_rx_bytes_per_sec)           AS network_rx_bytes_per_sec,
         AVG(network_tx_bytes_per_sec)           AS network_tx_bytes_per_sec,
         AVG(block_io_read_bytes_per_sec)        AS block_io_read_bytes_per_sec,
         AVG(block_io_write_bytes_per_sec)       AS block_io_write_bytes_per_sec
       FROM ${tier.relation}
       WHERE time >= $1 AND time <= $2
         AND container_id = ANY($4)
         ${hostFilter}
       GROUP BY time_bucket(make_interval(secs => $3), time), host
       ORDER BY time ASC`,
      params
    );
    return result.rows.map(toDockerStatsRow);
  }

  async getZFSStatsHistory(seconds: number): Promise<ZFSStatsRow[]> {
    const tier = resolveStatsTier('zfs_stats', seconds);
    const bucketSeconds = tierBucketSeconds(tier, seconds);
    const result = await this.pool.query<ZFSStatsQueryRow>(
      `SELECT
         time_bucket(make_interval(secs => $2), time) AS time,
         host,
         pool,
         last(entity, time)         AS entity,
         last(entity_type, time)    AS entity_type,
         last(indent, time)         AS indent,
         AVG(capacity_alloc)::float8 AS capacity_alloc,
         AVG(capacity_free)::float8  AS capacity_free,
         AVG(read_ops_per_sec)      AS read_ops_per_sec,
         AVG(write_ops_per_sec)     AS write_ops_per_sec,
         AVG(read_bytes_per_sec)    AS read_bytes_per_sec,
         AVG(write_bytes_per_sec)   AS write_bytes_per_sec,
         AVG(utilization_percent)   AS utilization_percent
       FROM ${tier.relation}
       WHERE time > NOW() - make_interval(secs => $1)
       GROUP BY time_bucket(make_interval(secs => $2), time), host, pool, entity
       ORDER BY time ASC`,
      [seconds, bucketSeconds]
    );
    return result.rows.map(toZFSStatsRow);
  }

  async insertProxmoxStats(rows: NewProxmoxStat[]): Promise<void> {
    if (rows.length === 0) return;

    try {
      const times: Date[] = [];
      const hosts: string[] = [];
      const entityTypes: string[] = [];
      const nodes: (string | null)[] = [];
      const entityIds: string[] = [];
      const entityNames: (string | null)[] = [];
      const statuses: (string | null)[] = [];
      const cpus: (number | null)[] = [];
      const maxCpus: (number | null)[] = [];
      const mems: (number | null)[] = [];
      const maxMems: (number | null)[] = [];
      const disks: (number | null)[] = [];
      const maxDisks: (number | null)[] = [];
      const uptimes: (number | null)[] = [];
      const vmids: (number | null)[] = [];
      const netins: (number | null)[] = [];
      const netouts: (number | null)[] = [];
      const storageTypes: (string | null)[] = [];
      const storageContents: (string | null)[] = [];
      const storageAvails: (number | null)[] = [];
      const storageShareds: (boolean | null)[] = [];
      const clusterVersions: (number | null)[] = [];

      for (const row of rows) {
        times.push(row.time);
        hosts.push(row.host);
        entityTypes.push(row.entity_type);
        nodes.push(row.node);
        entityIds.push(row.entity_id);
        entityNames.push(row.entity_name);
        statuses.push(row.status);
        cpus.push(row.cpu);
        maxCpus.push(row.max_cpu);
        mems.push(row.mem);
        maxMems.push(row.max_mem);
        disks.push(row.disk);
        maxDisks.push(row.max_disk);
        uptimes.push(row.uptime);
        vmids.push(row.vmid);
        netins.push(row.netin);
        netouts.push(row.netout);
        storageTypes.push(row.storage_type);
        storageContents.push(row.storage_content);
        storageAvails.push(row.storage_avail);
        storageShareds.push(row.storage_shared);
        clusterVersions.push(row.cluster_version);
      }

      await this.pool.query(
        `INSERT INTO proxmox_stats (
          time, host, entity_type, node, entity_id, entity_name, status,
          cpu, max_cpu, mem, max_mem, disk, max_disk, uptime,
          vmid, netin, netout,
          storage_type, storage_content, storage_avail, storage_shared,
          cluster_version
        )
        SELECT * FROM unnest(
          $1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
          $8::float8[], $9::float8[], $10::bigint[], $11::bigint[], $12::bigint[], $13::bigint[], $14::bigint[],
          $15::int[], $16::bigint[], $17::bigint[],
          $18::text[], $19::text[], $20::bigint[], $21::boolean[],
          $22::int[]
        )`,
        [
          times, hosts, entityTypes, nodes, entityIds, entityNames, statuses,
          cpus, maxCpus, mems, maxMems, disks, maxDisks, uptimes,
          vmids, netins, netouts,
          storageTypes, storageContents, storageAvails, storageShareds,
          clusterVersions,
        ]
      );
    } catch (err) {
      console.error('[StatsRepository] Failed to insert proxmox stats:', err);
      throw err;
    }
  }

  async getProxmoxStatsSince(since: Date): Promise<ProxmoxStatsRow[]> {
    const result = await this.pool.query<ProxmoxStatsQueryRow>(
      `SELECT
         time, host, entity_type, node, entity_id, entity_name, status,
         cpu, max_cpu,
         mem::float8 AS mem, max_mem::float8 AS max_mem,
         disk::float8 AS disk, max_disk::float8 AS max_disk,
         uptime::float8 AS uptime,
         vmid, netin::float8 AS netin, netout::float8 AS netout,
         storage_type, storage_content, storage_avail::float8 AS storage_avail,
         storage_shared, cluster_version
       FROM proxmox_stats WHERE time > $1 ORDER BY time ASC`,
      [since]
    );
    return result.rows.map(toProxmoxStatsRow);
  }

  async getProxmoxStatsHistory(seconds: number): Promise<ProxmoxStatsRow[]> {
    const tier = resolveStatsTier('proxmox_stats', seconds);
    const result = await this.pool.query<ProxmoxStatsQueryRow>(
      `SELECT
         time, host, entity_type, node, entity_id, entity_name, status,
         cpu, max_cpu,
         mem::float8 AS mem, max_mem::float8 AS max_mem,
         disk::float8 AS disk, max_disk::float8 AS max_disk,
         uptime::float8 AS uptime,
         vmid, netin::float8 AS netin, netout::float8 AS netout,
         storage_type, storage_content, storage_avail::float8 AS storage_avail,
         storage_shared, cluster_version
       FROM ${tier.relation}
       WHERE time > NOW() - make_interval(secs => $1)
       ORDER BY time ASC`,
      [seconds]
    );
    return result.rows.map(toProxmoxStatsRow);
  }

}

function toDockerStatsRow(row: DockerStatsQueryRow): DockerStatsRow {
  return {
    time: new Date(row.time).getTime(),
    host: row.host,
    container_id: row.container_id,
    container_name: row.container_name,
    image: row.image,
    cpu_percent: row.cpu_percent,
    memory_usage: row.memory_usage,
    memory_limit: row.memory_limit,
    memory_percent: row.memory_percent,
    network_rx_bytes_per_sec: row.network_rx_bytes_per_sec,
    network_tx_bytes_per_sec: row.network_tx_bytes_per_sec,
    block_io_read_bytes_per_sec: row.block_io_read_bytes_per_sec,
    block_io_write_bytes_per_sec: row.block_io_write_bytes_per_sec,
  };
}

function toZFSStatsRow(row: ZFSStatsQueryRow): ZFSStatsRow {
  return {
    time: new Date(row.time).getTime(),
    host: row.host,
    pool: row.pool,
    entity: row.entity,
    entity_type: row.entity_type,
    indent: row.indent,
    capacity_alloc: row.capacity_alloc,
    capacity_free: row.capacity_free,
    read_ops_per_sec: row.read_ops_per_sec,
    write_ops_per_sec: row.write_ops_per_sec,
    read_bytes_per_sec: row.read_bytes_per_sec,
    write_bytes_per_sec: row.write_bytes_per_sec,
    utilization_percent: row.utilization_percent,
  };
}

function toProxmoxStatsRow(row: ProxmoxStatsQueryRow): ProxmoxStatsRow {
  return {
    time: new Date(row.time).getTime(),
    host: row.host,
    entity_type: parseRowEnum('proxmox_stats.entity_type', row.entity_type, isProxmoxEntityType),
    node: row.node,
    entity_id: row.entity_id,
    entity_name: row.entity_name,
    status: row.status,
    cpu: row.cpu,
    max_cpu: row.max_cpu,
    mem: row.mem,
    max_mem: row.max_mem,
    disk: row.disk,
    max_disk: row.max_disk,
    uptime: row.uptime,
    vmid: row.vmid,
    netin: row.netin,
    netout: row.netout,
    storage_type: row.storage_type,
    storage_content: row.storage_content,
    storage_avail: row.storage_avail,
    storage_shared: row.storage_shared,
    cluster_version: row.cluster_version,
  };
}

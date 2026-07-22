import type { Pool } from 'pg';
import type { DockerStatsRow } from '@/types/docker';
import type { ProxmoxStatsRow } from '@/types/proxmox';
import type { ZFSStatsRow } from '@/types/zfs';

/**
 * Domain shape a docker stats collector produces after parsing an agent SSE
 * event: no knowledge of `docker_stats` column names or types required.
 */
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

/**
 * Domain shape the ZFS collector produces after parsing one `zpool iostat`
 * line: no knowledge of `zfs_stats` column names, bigint truncation, or the
 * utilization derivation required.
 */
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
        // capacity_alloc/capacity_free are bigint columns; zpool iostat parses
        // K/M/G/T/P suffixes with float math, so truncate before insert.
        capacityAllocs.push(Math.trunc(row.capacityAlloc));
        capacityFrees.push(Math.trunc(row.capacityFree));
        readOps.push(row.readOpsPerSec);
        writeOps.push(row.writeOpsPerSec);
        readBytes.push(row.readBytesPerSec);
        writeBytes.push(row.writeBytesPerSec);
        // zpool iostat already reports ops/bandwidth as per-second rates, so
        // no delta-over-time math is needed; utilization is the only value
        // actually derived here.
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
    const result = await this.pool.query(
      `SELECT * FROM docker_stats WHERE time > $1 ORDER BY time ASC`,
      [since]
    );
    return result.rows.map(toDockerStatsRow);
  }

  async getZFSStatsSince(since: Date): Promise<ZFSStatsRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM zfs_stats WHERE time > $1 ORDER BY time ASC`,
      [since]
    );
    return result.rows.map(toZFSStatsRow);
  }

  async getDockerStatsHistory(seconds: number): Promise<DockerStatsRow[]> {
    // Target ~300 data points per entity: bucket larger windows to avoid sending
    // thousands of 1-second rows over the wire for windows like 30 minutes.
    const bucketSeconds = Math.max(1, Math.ceil(seconds / 300));
    const result = await this.pool.query(
      `SELECT
         time_bucket(make_interval(secs => $2), time) AS time,
         host,
         container_id,
         last(container_name, time)              AS container_name,
         last(image, time)                       AS image,
         AVG(cpu_percent)                        AS cpu_percent,
         AVG(memory_usage)                       AS memory_usage,
         AVG(memory_limit)                       AS memory_limit,
         AVG(memory_percent)                     AS memory_percent,
         AVG(network_rx_bytes_per_sec)           AS network_rx_bytes_per_sec,
         AVG(network_tx_bytes_per_sec)           AS network_tx_bytes_per_sec,
         AVG(block_io_read_bytes_per_sec)        AS block_io_read_bytes_per_sec,
         AVG(block_io_write_bytes_per_sec)       AS block_io_write_bytes_per_sec
       FROM docker_stats
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
    // Find the actual data extent so we bucket based on real data density
    // rather than the full requested range. This prevents low-resolution graphs
    // when the requested range exceeds the available data.
    const boundsParams: (string | Date | string[])[] = [from, to, containerIds];
    const boundsHostFilter = host ? `AND host = $${boundsParams.push(host)}` : '';

    const boundsResult = await this.pool.query(
      `SELECT EXTRACT(EPOCH FROM (MAX(time) - MIN(time))) AS actual_span_secs
       FROM docker_stats
       WHERE time >= $1 AND time <= $2
         AND container_id = ANY($3)
         ${boundsHostFilter}`,
      boundsParams
    );

    const actualSpanSecs = Number(boundsResult.rows[0]?.actual_span_secs) || 0;
    const requestedSpanSecs = (to.getTime() - from.getTime()) / 1000;
    const effectiveSpan = actualSpanSecs > 0
      ? Math.min(actualSpanSecs, requestedSpanSecs)
      : requestedSpanSecs;
    const bucketSeconds = Math.max(1, Math.ceil(effectiveSpan / targetPoints));

    const params: (string | Date | number | string[])[] = [from, to, bucketSeconds, containerIds];
    const hostFilter = host ? `AND host = $${params.push(host)}` : '';

    const result = await this.pool.query(
      `SELECT
         time_bucket(make_interval(secs => $3), time) AS time,
         host,
         last(container_id, time)                AS container_id,
         last(container_name, time)              AS container_name,
         last(image, time)                       AS image,
         AVG(cpu_percent)                        AS cpu_percent,
         AVG(memory_usage)                       AS memory_usage,
         AVG(memory_limit)                       AS memory_limit,
         AVG(memory_percent)                     AS memory_percent,
         AVG(network_rx_bytes_per_sec)           AS network_rx_bytes_per_sec,
         AVG(network_tx_bytes_per_sec)           AS network_tx_bytes_per_sec,
         AVG(block_io_read_bytes_per_sec)        AS block_io_read_bytes_per_sec,
         AVG(block_io_write_bytes_per_sec)       AS block_io_write_bytes_per_sec
       FROM docker_stats
       WHERE time >= $1 AND time <= $2
         AND container_id = ANY($4)
         ${hostFilter}
       GROUP BY time_bucket(make_interval(secs => $3), time), host
       ORDER BY time ASC`,
      params
    );
    return result.rows.map(toDockerStatsRow);
  }

  async getContainerInfo(
    containerId: string,
    host?: string,
  ): Promise<{ container_name: string | null; image: string | null; host: string } | null> {
    const params: string[] = [containerId];
    const hostFilter = host ? `AND host = $${params.push(host)}` : '';

    const result = await this.pool.query(
      `SELECT container_name, image, host
       FROM docker_stats
       WHERE container_id = $1 ${hostFilter}
       ORDER BY time DESC
       LIMIT 1`,
      params
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      container_name: row.container_name ?? null,
      image: row.image ?? null,
      host: row.host,
    };
  }

  async getZFSStatsHistory(seconds: number): Promise<ZFSStatsRow[]> {
    const bucketSeconds = Math.max(1, Math.ceil(seconds / 300));
    const result = await this.pool.query(
      `SELECT
         time_bucket(make_interval(secs => $2), time) AS time,
         host,
         pool,
         last(entity, time)         AS entity,
         last(entity_type, time)    AS entity_type,
         last(indent, time)         AS indent,
         AVG(capacity_alloc)        AS capacity_alloc,
         AVG(capacity_free)         AS capacity_free,
         AVG(read_ops_per_sec)      AS read_ops_per_sec,
         AVG(write_ops_per_sec)     AS write_ops_per_sec,
         AVG(read_bytes_per_sec)    AS read_bytes_per_sec,
         AVG(write_bytes_per_sec)   AS write_bytes_per_sec,
         AVG(utilization_percent)   AS utilization_percent
       FROM zfs_stats
       WHERE time > NOW() - make_interval(secs => $1)
       GROUP BY time_bucket(make_interval(secs => $2), time), host, pool, entity
       ORDER BY time ASC`,
      [seconds, bucketSeconds]
    );
    return result.rows.map(toZFSStatsRow);
  }

  async insertProxmoxStats(rows: ProxmoxStatsRow[]): Promise<void> {
    if (rows.length === 0) return;

    try {
      const times: (string | Date)[] = [];
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
    const result = await this.pool.query(
      `SELECT * FROM proxmox_stats WHERE time > $1 ORDER BY time ASC`,
      [since]
    );
    return result.rows.map(toProxmoxStatsRow);
  }

  async getProxmoxStatsHistory(seconds: number): Promise<ProxmoxStatsRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM proxmox_stats
       WHERE time > NOW() - make_interval(secs => $1)
       ORDER BY time ASC`,
      [seconds]
    );
    return result.rows.map(toProxmoxStatsRow);
  }

}

/**
 * Convert a raw PostgreSQL result row into a DockerStatsRow, coercing numeric fields to JS numbers.
 *
 * Numeric and bigint-derived fields returned as strings from the database are converted to Number;
 * missing or undefined values are mapped to `null`.
 *
 * @param row - Raw row returned by pg for a docker_stats query
 * @returns A DockerStatsRow with numeric fields converted to numbers or `null` where absent
 */
function toDockerStatsRow(row: Record<string, unknown>): DockerStatsRow {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    time: row.time as string | Date,
    host: row.host as string,
    container_id: row.container_id as string,
    container_name: row.container_name as string | null,
    image: row.image as string | null,
    cpu_percent: n(row.cpu_percent),
    memory_usage: n(row.memory_usage),
    memory_limit: n(row.memory_limit),
    memory_percent: n(row.memory_percent),
    network_rx_bytes_per_sec: n(row.network_rx_bytes_per_sec),
    network_tx_bytes_per_sec: n(row.network_tx_bytes_per_sec),
    block_io_read_bytes_per_sec: n(row.block_io_read_bytes_per_sec),
    block_io_write_bytes_per_sec: n(row.block_io_write_bytes_per_sec),
  };
}

/** Convert a raw pg row to ZFSStatsRow, coercing BIGINT strings to numbers. */
function toZFSStatsRow(row: Record<string, unknown>): ZFSStatsRow {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    time: row.time as string | Date,
    host: row.host as string,
    pool: row.pool as string,
    entity: row.entity as string,
    entity_type: row.entity_type as string,
    indent: Number(row.indent),
    capacity_alloc: n(row.capacity_alloc),
    capacity_free: n(row.capacity_free),
    read_ops_per_sec: n(row.read_ops_per_sec),
    write_ops_per_sec: n(row.write_ops_per_sec),
    read_bytes_per_sec: n(row.read_bytes_per_sec),
    write_bytes_per_sec: n(row.write_bytes_per_sec),
    utilization_percent: n(row.utilization_percent),
  };
}

/** Convert a raw pg row to ProxmoxStatsRow, coercing BIGINT strings to numbers. */
function toProxmoxStatsRow(row: Record<string, unknown>): ProxmoxStatsRow {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    time: row.time as string | Date,
    host: row.host as string,
    entity_type: row.entity_type as ProxmoxStatsRow['entity_type'],
    node: row.node as string | null,
    entity_id: row.entity_id as string,
    entity_name: row.entity_name as string | null,
    status: row.status as string | null,
    cpu: n(row.cpu),
    max_cpu: n(row.max_cpu),
    mem: n(row.mem),
    max_mem: n(row.max_mem),
    disk: n(row.disk),
    max_disk: n(row.max_disk),
    uptime: n(row.uptime),
    vmid: n(row.vmid),
    netin: n(row.netin),
    netout: n(row.netout),
    storage_type: row.storage_type as string | null,
    storage_content: row.storage_content as string | null,
    storage_avail: n(row.storage_avail),
    storage_shared: row.storage_shared as boolean | null,
    cluster_version: n(row.cluster_version),
  };
}

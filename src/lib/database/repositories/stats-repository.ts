import type { Pool } from 'pg';
import type { DockerStatsRow } from '@/types/docker';
import type { ZFSStatsRow } from '@/types/zfs';

export class StatsRepository {
  constructor(private pool: Pool) {}

  async insertDockerStats(rows: DockerStatsRow[]): Promise<void> {
    if (rows.length === 0) return;

    try {
      const times: (string | Date)[] = [];
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
        containerIds.push(row.container_id);
        containerNames.push(row.container_name);
        images.push(row.image);
        cpuPercents.push(row.cpu_percent);
        memoryUsages.push(row.memory_usage);
        memoryLimits.push(row.memory_limit);
        memoryPercents.push(row.memory_percent);
        networkRx.push(row.network_rx_bytes_per_sec);
        networkTx.push(row.network_tx_bytes_per_sec);
        blockRead.push(row.block_io_read_bytes_per_sec);
        blockWrite.push(row.block_io_write_bytes_per_sec);
      }

      const result = await this.pool.query(
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
        )
        RETURNING seq`,
        [
          times, hosts, containerIds, containerNames, images,
          cpuPercents, memoryUsages, memoryLimits, memoryPercents,
          networkRx, networkTx, blockRead, blockWrite,
        ]
      );

      const maxSeq = result.rows[result.rows.length - 1].seq;
      await this.pool.query(
        `SELECT pg_notify('stats_update', $1)`,
        [JSON.stringify({ source: 'docker', maxSeq: String(maxSeq) })]
      );
    } catch (err) {
      console.error('[StatsRepository] Failed to insert docker stats:', err);
      throw err;
    }
  }

  async insertZFSStats(rows: ZFSStatsRow[]): Promise<void> {
    if (rows.length === 0) return;

    try {
      const times: (string | Date)[] = [];
      const hosts: string[] = [];
      const pools: string[] = [];
      const entities: string[] = [];
      const entityTypes: string[] = [];
      const indents: number[] = [];
      const capacityAllocs: (number | null)[] = [];
      const capacityFrees: (number | null)[] = [];
      const readOps: (number | null)[] = [];
      const writeOps: (number | null)[] = [];
      const readBytes: (number | null)[] = [];
      const writeBytes: (number | null)[] = [];
      const utilizations: (number | null)[] = [];

      for (const row of rows) {
        times.push(row.time);
        hosts.push(row.host);
        pools.push(row.pool);
        entities.push(row.entity);
        entityTypes.push(row.entity_type);
        indents.push(row.indent);
        capacityAllocs.push(row.capacity_alloc);
        capacityFrees.push(row.capacity_free);
        readOps.push(row.read_ops_per_sec);
        writeOps.push(row.write_ops_per_sec);
        readBytes.push(row.read_bytes_per_sec);
        writeBytes.push(row.write_bytes_per_sec);
        utilizations.push(row.utilization_percent);
      }

      const result = await this.pool.query(
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
        )
        RETURNING seq`,
        [
          times, hosts, pools, entities, entityTypes, indents,
          capacityAllocs, capacityFrees,
          readOps, writeOps,
          readBytes, writeBytes,
          utilizations,
        ]
      );

      const maxSeq = result.rows[result.rows.length - 1].seq;
      await this.pool.query(
        `SELECT pg_notify('stats_update', $1)`,
        [JSON.stringify({ source: 'zfs', maxSeq: String(maxSeq) })]
      );
    } catch (err) {
      console.error('[StatsRepository] Failed to insert zfs stats:', err);
      throw err;
    }
  }

  async getDockerStatsSinceSeq(sinceSeq: string): Promise<DockerStatsRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM docker_stats WHERE seq > $1 ORDER BY seq ASC`,
      [sinceSeq]
    );
    return result.rows;
  }

  async getZFSStatsSinceSeq(sinceSeq: string): Promise<ZFSStatsRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM zfs_stats WHERE seq > $1 ORDER BY seq ASC`,
      [sinceSeq]
    );
    return result.rows;
  }

  async getMaxDockerSeq(): Promise<string> {
    const result = await this.pool.query(
      `SELECT COALESCE(MAX(seq), 0) as max_seq FROM docker_stats`
    );
    return String(result.rows[0].max_seq);
  }

  async getMaxZFSSeq(): Promise<string> {
    const result = await this.pool.query(
      `SELECT COALESCE(MAX(seq), 0) as max_seq FROM zfs_stats`
    );
    return String(result.rows[0].max_seq);
  }

  async getDockerStatsHistory(seconds: number): Promise<DockerStatsRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM docker_stats
       WHERE time > NOW() - make_interval(secs => $1)
       ORDER BY time ASC`,
      [seconds]
    );
    return result.rows;
  }

  async getZFSStatsHistory(seconds: number): Promise<ZFSStatsRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM zfs_stats
       WHERE time > NOW() - make_interval(secs => $1)
       ORDER BY time ASC`,
      [seconds]
    );
    return result.rows;
  }

  async upsertEntityMetadata(
    source: string,
    entity: string,
    key: string,
    value: string
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO entity_metadata (source, entity, key, value, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (source, entity, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [source, entity, key, value]
    );
  }

  async getEntityMetadata(
    source: string,
    entities: string[]
  ): Promise<Map<string, Map<string, string>>> {
    if (entities.length === 0) return new Map();

    const result = await this.pool.query(
      `SELECT entity, key, value
       FROM entity_metadata
       WHERE source = $1 AND entity = ANY($2)`,
      [source, entities]
    );

    const metadata = new Map<string, Map<string, string>>();
    for (const row of result.rows as { entity: string; key: string; value: string }[]) {
      if (!metadata.has(row.entity)) {
        metadata.set(row.entity, new Map());
      }
      metadata.get(row.entity)!.set(row.key, row.value);
    }
    return metadata;
  }
}

import type { Pool } from 'pg';
import { z } from 'zod';
import { zZFSPoolHealth, type ZFSHostHealth, type ZFSPoolHealth } from '@/types/zfs';

export const ZFS_HEALTH_NOTIFY_CHANNEL = 'zfs_health_change';

const zStoredPools = z.array(zZFSPoolHealth);

interface ZfsHostHealthQueryRow {
  host: string;
  readable: boolean;
  connected: boolean;
  pools: unknown;
  last_seen_at: Date;
}

export class ZfsHealthRepository {
  constructor(private readonly pool: Pool) {}

  async recordHealth(host: string, pools: ZFSPoolHealth[]): Promise<void> {
    await this.pool.query(
      `INSERT INTO zfs_host_health (host, readable, connected, pools, last_seen_at)
       VALUES ($1, TRUE, TRUE, $2::jsonb, now())
       ON CONFLICT (host) DO UPDATE SET
         readable = TRUE,
         connected = TRUE,
         pools = EXCLUDED.pools,
         last_seen_at = now()`,
      [host, JSON.stringify(pools)],
    );
  }

  /** Keeps the last health the agent could read. */
  async recordUnreadable(host: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO zfs_host_health (host, readable, connected, last_seen_at)
       VALUES ($1, FALSE, TRUE, now())
       ON CONFLICT (host) DO UPDATE SET
         readable = FALSE,
         connected = TRUE,
         last_seen_at = now()`,
      [host],
    );
  }

  /** Only the first call after the stream drops moves `last_seen_at`, so retries keep when the host was last seen. */
  async recordDisconnected(host: string): Promise<void> {
    await this.pool.query(
      `UPDATE zfs_host_health SET connected = FALSE, last_seen_at = now()
       WHERE host = $1 AND connected`,
      [host],
    );
  }

  /** Hosts that still collect ZFS, sorted by name. A row whose pools are off the schema is left out and logged. */
  async list(): Promise<ZFSHostHealth[]> {
    const result = await this.pool.query<ZfsHostHealthQueryRow>(
      `SELECT h.host, h.readable, h.connected, h.pools, h.last_seen_at
       FROM zfs_host_health h
       JOIN managed_hosts m ON m.name = h.host
       WHERE m.capabilities->>'zfs' = 'true'
       ORDER BY h.host`,
    );
    return result.rows.flatMap((row) => {
      const pools = zStoredPools.safeParse(row.pools);
      if (!pools.success) {
        console.error(`[ZfsHealthRepository] Stored pool health for ${row.host} is off the schema:`, pools.error.message);
        return [];
      }
      return [{
        host: row.host,
        readable: row.readable,
        connected: row.connected,
        lastSeenAt: row.last_seen_at.getTime(),
        pools: pools.data,
      }];
    });
  }
}

import type { Pool } from 'pg';
import {
  PROXMOX_COLLECTOR_STATES,
  type ProxmoxCollectorState,
  type ProxmoxCollectorStateKind,
} from '@/types/proxmox';
import { parseRowEnumOr } from '@/lib/database/repositories/row-enum';

export const PROXMOX_STATE_NOTIFY_CHANNEL = 'proxmox_state_change';

interface ProxmoxCollectorStateQueryRow {
  connection_id: string;
  host: string;
  port: number;
  state: string;
  reason: string | null;
  last_success_at: Date | null;
  updated_at: Date;
}

export interface ProxmoxCollectorStateWrite {
  connectionId: string;
  host: string;
  port: number;
  state: ProxmoxCollectorStateKind;
  reason: string | null;
  /** Null keeps the stored value, so a worker that restarts into an outage still reports when data last arrived. */
  lastSuccessAt: Date | null;
}

export class ProxmoxStateRepository {
  constructor(private readonly pool: Pool) {}

  async record(write: ProxmoxCollectorStateWrite): Promise<void> {
    await this.pool.query(
      `INSERT INTO proxmox_collector_state (connection_id, host, port, state, reason, last_success_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (connection_id) DO UPDATE SET
         host = EXCLUDED.host,
         port = EXCLUDED.port,
         state = EXCLUDED.state,
         reason = EXCLUDED.reason,
         last_success_at = COALESCE(EXCLUDED.last_success_at, proxmox_collector_state.last_success_at),
         updated_at = now()`,
      [write.connectionId, write.host, write.port, write.state, write.reason, write.lastSuccessAt],
    );
  }

  /** A collector stopped mid-poll can write its state after the connection's row is gone. */
  async removeOrphans(): Promise<void> {
    await this.pool.query(
      `DELETE FROM proxmox_collector_state s
       WHERE NOT EXISTS (SELECT 1 FROM proxmox_connections c WHERE c.id::text = s.connection_id)`,
    );
  }

  /** One entry per saved connection. One the worker has not reported on yet reads as collecting. */
  async list(): Promise<ProxmoxCollectorState[]> {
    const result = await this.pool.query<ProxmoxCollectorStateQueryRow>(
      `SELECT c.id::text AS connection_id, c.address AS host, c.port,
              COALESCE(s.state, 'collecting') AS state, s.reason, s.last_success_at,
              COALESCE(s.updated_at, c.updated_at) AS updated_at
       FROM proxmox_connections c
       LEFT JOIN proxmox_collector_state s ON s.connection_id = c.id::text
       ORDER BY c.id`,
    );
    return result.rows.flatMap((row) => {
      const state = parseRowEnumOr('proxmox_collector_state.state', row.state, PROXMOX_COLLECTOR_STATES, null);
      if (state === null) return [];
      return [{
        connectionId: row.connection_id,
        host: row.host,
        port: row.port,
        state,
        reason: row.reason,
        lastSuccessAt: row.last_success_at?.getTime() ?? null,
        updatedAt: row.updated_at.getTime(),
      }];
    });
  }
}

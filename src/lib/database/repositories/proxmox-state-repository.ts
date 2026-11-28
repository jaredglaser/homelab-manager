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

  /**
   * The startup `collecting` row: written only where no state is recorded or the collector was off,
   * so a restart does not hide a recorded failure until the first poll fails again.
   */
  async recordCollectingIfUnknown(write: Omit<ProxmoxCollectorStateWrite, 'state' | 'reason' | 'lastSuccessAt'>): Promise<void> {
    await this.pool.query(
      `INSERT INTO proxmox_collector_state (connection_id, host, port, state, updated_at)
       VALUES ($1, $2, $3, 'collecting', now())
       ON CONFLICT (connection_id) DO UPDATE SET
         host = EXCLUDED.host,
         port = EXCLUDED.port,
         state = 'collecting',
         reason = NULL,
         updated_at = now()
       WHERE proxmox_collector_state.state = 'collector_off'`,
      [write.connectionId, write.host, write.port],
    );
  }

  /** Drops the rows of connections the worker no longer has, so a removed connection stops showing its last state. */
  async removeAllExcept(connectionIds: string[]): Promise<void> {
    await this.pool.query(
      'DELETE FROM proxmox_collector_state WHERE NOT (connection_id = ANY($1::text[]))',
      [connectionIds],
    );
  }

  async list(): Promise<ProxmoxCollectorState[]> {
    const result = await this.pool.query<ProxmoxCollectorStateQueryRow>(
      `SELECT connection_id, host, port, state, reason, last_success_at, updated_at
       FROM proxmox_collector_state ORDER BY connection_id`,
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

import type { Pool } from 'pg';
import type { StackContainer } from '@/types/stacks';

/** A single row from the stack_status table. */
export interface StackStatusRow {
  stack: string;
  host: string;
  containers: StackContainer[];
  updated_at: Date;
}

/** Repository for reading and writing live stack container status. */
export class StackStatusRepository {
  constructor(private pool: Pool) {}

  /** Upserts the container list for a stack/host pair. */
  async upsertStackStatus(stack: string, host: string, containers: StackContainer[]): Promise<void> {
    await this.pool.query(
      `INSERT INTO stack_status (stack, host, containers, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (stack, host)
       DO UPDATE SET containers = $3, updated_at = now()`,
      [stack, host, JSON.stringify(containers)],
    );
  }

  /** Returns all stack status rows ordered by stack, then host. */
  async getAll(): Promise<StackStatusRow[]> {
    const { rows } = await this.pool.query(
      'SELECT stack, host, containers, updated_at FROM stack_status ORDER BY stack, host',
    );
    return rows;
  }

  /** Returns the status row for a specific stack/host pair, or null if absent. */
  async getByStackHost(stack: string, host: string): Promise<StackStatusRow | null> {
    const { rows } = await this.pool.query(
      'SELECT stack, host, containers, updated_at FROM stack_status WHERE stack = $1 AND host = $2',
      [stack, host],
    );
    return rows[0] ?? null;
  }

  /** Returns all stack status rows for a given host, ordered by stack name. */
  async getByHost(host: string): Promise<StackStatusRow[]> {
    const { rows } = await this.pool.query(
      'SELECT stack, host, containers, updated_at FROM stack_status WHERE host = $1 ORDER BY stack',
      [host],
    );
    return rows;
  }

  /** Deletes the status row for a specific stack/host pair. */
  async deleteByStackHost(stack: string, host: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM stack_status WHERE stack = $1 AND host = $2',
      [stack, host],
    );
  }
}

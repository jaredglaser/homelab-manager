import type { Pool } from 'pg';
import type { DeployRecord, DeployStatus, DeployTrigger } from '@/lib/deploy/types';

interface InsertDeployParams {
  stack: string;
  host: string;
  commitSha: string;
  composeHash: string;
  envHash: string;
  status: DeployStatus;
  trigger: DeployTrigger;
}

export class DeployRepository {
  constructor(private pool: Pool) {}

  async insertDeploy(params: InsertDeployParams): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO deploy_history (stack, host, commit_sha, compose_hash, env_hash, status, trigger)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [params.stack, params.host, params.commitSha, params.composeHash, params.envHash, params.status, params.trigger]
    );
    return Number(result.rows[0].id);
  }

  /**
   * Atomically insert a deploy record, relying on the partial unique index
   * (idx_deploy_one_active_per_stack_host) to reject duplicates.
   * Returns the new deploy id, or null if an active deploy already exists.
   */
  async insertDeployIfNoActive(params: InsertDeployParams): Promise<number | null> {
    try {
      return await this.insertDeploy(params);
    } catch (err: unknown) {
      if (isActiveDeployConflict(err)) return null;
      throw err;
    }
  }

  async getById(id: number): Promise<DeployRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM deploy_history WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) return null;
    return toDeployRecord(result.rows[0]);
  }

  async updateStatus(id: number, status: DeployStatus, logs?: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE deploy_history SET status = $2, logs = $3 WHERE id = $1`,
      [id, status, logs ?? null]
    );
    if (result.rowCount === 0) {
      throw new Error(`Deploy record ${id} not found when updating status to "${status}"`);
    }
  }

  async getLatestSuccessful(stack: string, host: string): Promise<DeployRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM deploy_history
       WHERE stack = $1 AND host = $2 AND status = 'succeeded'
       ORDER BY created_at DESC
       LIMIT 1`,
      [stack, host]
    );
    if (result.rows.length === 0) return null;
    return toDeployRecord(result.rows[0]);
  }

  async hasActiveDeployForStack(stack: string, host: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT COUNT(*) as count FROM deploy_history
       WHERE stack = $1 AND host = $2 AND status IN ('pending', 'in_progress')`,
      [stack, host]
    );
    return Number(result.rows[0].count) > 0;
  }

  async getDeployHistory(stack: string, host: string, limit: number): Promise<DeployRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM deploy_history
       WHERE stack = $1 AND host = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [stack, host, limit]
    );
    return result.rows.map(toDeployRecord);
  }

  async deduplicatePending(stack: string, host: string, keepId: number): Promise<void> {
    await this.pool.query(
      `DELETE FROM deploy_history
       WHERE stack = $1 AND host = $2 AND status = $3 AND id != $4`,
      [stack, host, 'pending', keepId]
    );
  }

  async getPendingDeploys(): Promise<DeployRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM deploy_history
       WHERE status = 'pending'
       ORDER BY created_at ASC`
    );
    return result.rows.map(toDeployRecord);
  }

  /**
   * Return the single most-recent deploy record per (stack, host) pair.
   * Uses DISTINCT ON (stack, host) ordered by created_at DESC for an efficient single-pass query.
   */
  async getLatestDeployPerStack(): Promise<DeployRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT ON (stack, host) id, stack, host, commit_sha, compose_hash, env_hash, status, trigger, logs, created_at
       FROM deploy_history
       ORDER BY stack, host, created_at DESC`
    );
    return rows.map(toDeployRecord);
  }

  async notifyStackChange(stack: string, host: string): Promise<void> {
    await this.pool.query("SELECT pg_notify('stack_change', $1 || '/' || $2)", [stack, host]);
  }
}

/** Check for the specific active-deploy unique constraint violation. */
function isActiveDeployConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const pg = err as Record<string, unknown>;
  return pg.code === '23505' && pg.constraint === 'idx_deploy_one_active_per_stack_host';
}

function toDeployRecord(row: Record<string, unknown>): DeployRecord {
  return {
    id: Number(row.id),
    stack: row.stack as string,
    host: row.host as string,
    commitSha: row.commit_sha as string,
    composeHash: row.compose_hash as string,
    envHash: row.env_hash as string,
    status: row.status as DeployRecord['status'],
    trigger: row.trigger as DeployRecord['trigger'],
    logs: (row.logs as string) ?? null,
    createdAt: row.created_at as Date,
  };
}

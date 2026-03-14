// src/lib/database/repositories/deploy-repository.ts

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

  async updateStatus(id: number, status: DeployStatus, logs?: string): Promise<void> {
    await this.pool.query(
      `UPDATE deploy_history SET status = $2, logs = $3 WHERE id = $1`,
      [id, status, logs ?? null]
    );
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

  async hasActiveDeployForStack(stack: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT COUNT(*) as count FROM deploy_history
       WHERE stack = $1 AND status IN ('pending', 'in_progress')`,
      [stack]
    );
    return Number(result.rows[0].count) > 0;
  }

  async getDeployHistory(stack: string, limit: number): Promise<DeployRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM deploy_history
       WHERE stack = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [stack, limit]
    );
    return result.rows.map(toDeployRecord);
  }

  async deduplicatePending(stack: string, keepId: number): Promise<void> {
    await this.pool.query(
      `DELETE FROM deploy_history
       WHERE stack = $1 AND status = $2 AND id != $3`,
      [stack, 'pending', keepId]
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

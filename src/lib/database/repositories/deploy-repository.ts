import type { Pool } from 'pg';
import type { DeployAction, DeployPostSuccess, DeployRecord, DeployStatus, DeployTrigger } from '@/lib/deploy/types';
import { truncateDeployMessage } from '@/lib/stacks/deploy-outcome-toast';

export interface StuckDeployRow {
  id: number;
  stack: string;
  host: string;
  action: DeployAction;
  trigger: DeployTrigger;
}

export interface PostSuccessDeployRow {
  id: number;
  stack: string;
  host: string;
}

/** Outcome attached to a deploy_change NOTIFY so subscribers can render a toast without a follow-up query. */
export interface DeployChangeOutcome {
  deployId: number;
  status: DeployStatus;
  action: DeployAction;
  trigger: DeployTrigger;
  message?: string;
}

interface InsertDeployParams {
  stack: string;
  host: string;
  commitSha: string;
  composeHash: string;
  envHash: string;
  status: DeployStatus;
  trigger: DeployTrigger;
  action: DeployAction;
  forceRecreate?: boolean;
  postSuccess?: DeployPostSuccess | null;
}

export class DeployRepository {
  constructor(private readonly pool: Pool) {}

  async insertDeploy(params: InsertDeployParams): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO deploy_history (stack, host, commit_sha, compose_hash, env_hash, status, trigger, action, force_recreate, post_success)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        params.stack,
        params.host,
        params.commitSha,
        params.composeHash,
        params.envHash,
        params.status,
        params.trigger,
        params.action,
        params.forceRecreate ?? false,
        params.postSuccess ?? null,
      ]
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
    // Stamp started_at the first time a row enters in_progress so the watchdog
    // can age it from when it actually began, not from insert time.
    const result = await this.pool.query(
      `UPDATE deploy_history
       SET status = $2,
           logs = $3,
           started_at = CASE
             WHEN $2 = 'in_progress' AND started_at IS NULL THEN NOW()
             ELSE started_at
           END
       WHERE id = $1`,
      [id, status, logs ?? null]
    );
    if (result.rowCount === 0) {
      throw new Error(`Deploy record ${id} not found when updating status to "${status}"`);
    }
  }

  /**
   * Atomically claim a pending deploy by transitioning it to 'in_progress'.
   * The WHERE clause guards against concurrent approvals: only one caller will
   * see rowCount > 0. Returns true if this caller won the race, false if the
   * deploy was already claimed (or no longer exists).
   */
  async claimPending(id: number): Promise<boolean> {
    // Stamp started_at on claim: a pending row may have sat awaiting approval
    // for far longer than the watchdog threshold, and the watchdog ages from
    // started_at so it doesn't fail the deploy the instant it begins.
    const result = await this.pool.query(
      `UPDATE deploy_history SET status = 'in_progress', started_at = NOW() WHERE id = $1 AND status = 'pending'`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Atomically reject a pending deploy by transitioning it to 'failed' with the
   * supplied log message. The WHERE clause guards against rejecting an already
   * claimed (in-progress) deploy. Returns true if this caller won the race.
   */
  async rejectPending(id: number, logs: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE deploy_history SET status = 'failed', logs = $2 WHERE id = $1 AND status = 'pending'`,
      [id, logs]
    );
    return (result.rowCount ?? 0) > 0;
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
      `SELECT DISTINCT ON (stack, host) id, stack, host, commit_sha, compose_hash, env_hash, status, trigger, action, force_recreate, logs, created_at, post_success
       FROM deploy_history
       ORDER BY stack, host, created_at DESC`
    );
    return rows.map(toDeployRecord);
  }

  /**
   * Find deploys that reached a terminal-success state with the given
   * `post_success` value. Used by startup recovery to sweep up orphaned
   * post-success hooks (e.g. manifest removals that never ran because the
   * process crashed between status update and hook execution). Caller is
   * responsible for filtering by current manifest contents.
   */
  async findSucceededPostSuccessDeploys(
    kind: DeployPostSuccess,
  ): Promise<PostSuccessDeployRow[]> {
    const result = await this.pool.query(
      `SELECT id, stack, host
       FROM deploy_history
       WHERE status IN ('succeeded', 'no_change')
         AND post_success = $1
       ORDER BY created_at DESC`,
      [kind],
    );
    return result.rows.map((row) => ({
      id: Number(row.id),
      stack: row.stack as string,
      host: row.host as string,
    }));
  }

  async notifyStackChange(stack: string, host: string, outcome?: DeployChangeOutcome): Promise<void> {
    const payload = JSON.stringify({
      type: 'deploy_changed',
      stack,
      host,
      ...(outcome ? {
        deployId: outcome.deployId,
        status: outcome.status,
        action: outcome.action,
        trigger: outcome.trigger,
        ...(outcome.message ? { message: truncateDeployMessage(outcome.message) } : {}),
      } : {}),
    });
    await this.pool.query("SELECT pg_notify('deploy_change', $1)", [payload]);
  }

  /**
   * Fails ALL pending/in_progress deploy_history rows unconditionally, overwriting
   * `logs` with `logMessage` (any partial agent output is lost). Safe only for
   * single-instance/single-worker startup recovery: do not call in multi-process
   * deployments where another instance may own active rows. Returns the recovered rows.
   */
  async recoverStuckDeploys(logMessage: string): Promise<StuckDeployRow[]> {
    const result = await this.pool.query(
      `UPDATE deploy_history
       SET status = 'failed', logs = $1
       WHERE status IN ('pending', 'in_progress')
       RETURNING id, stack, host, action, trigger`,
      [logMessage],
    );
    return result.rows.map(toStuckDeployRow);
  }

  /**
   * Fails in_progress deploys older than thresholdMinutes, overwriting `logs`
   * with `logMessage`. Returns the timed-out rows.
   */
  async timeoutStuckDeploys(
    thresholdMinutes: number,
    logMessage: string,
  ): Promise<StuckDeployRow[]> {
    // Age from started_at (when the deploy entered in_progress), falling back
    // to created_at for legacy rows written before started_at existed.
    const result = await this.pool.query(
      `UPDATE deploy_history
       SET status = 'failed', logs = $2
       WHERE status = 'in_progress'
         AND COALESCE(started_at, created_at) < NOW() - make_interval(mins => $1)
       RETURNING id, stack, host, action, trigger`,
      [thresholdMinutes, logMessage],
    );
    return result.rows.map(toStuckDeployRow);
  }
}

function toStuckDeployRow(row: Record<string, unknown>): StuckDeployRow {
  return {
    id: Number(row.id),
    stack: row.stack as string,
    host: row.host as string,
    action: row.action as DeployAction,
    trigger: row.trigger as DeployTrigger,
  };
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
    action: (row.action as DeployRecord['action']) ?? 'deploy',
    forceRecreate: row.force_recreate === true,
    logs: (row.logs as string) ?? null,
    createdAt: row.created_at as Date,
    postSuccess: (row.post_success as DeployRecord['postSuccess']) ?? null,
  };
}

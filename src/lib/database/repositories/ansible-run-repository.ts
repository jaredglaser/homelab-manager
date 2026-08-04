import type { Pool } from 'pg';
import type {
  AnsibleHostSummary,
  AnsibleRun,
  AnsibleRunEvent,
  AnsibleRunStatus,
} from '@/types/ansible';

export interface CreateAnsibleRunInput {
  runId: string;
  playbook: string;
  hosts: string[];
  checkMode: boolean;
  requestedBy: string;
}

export interface StrandedAnsibleRunRow {
  id: number;
  runId: string;
}

function toStrandedRow(row: Record<string, unknown>): StrandedAnsibleRunRow {
  return { id: Number(row.id), runId: row.run_id as string };
}

function toRun(row: Record<string, unknown>): AnsibleRun {
  const finishedAt = row.finished_at as Date | null;
  return {
    id: Number(row.id),
    runId: row.run_id as string,
    playbook: row.playbook as string,
    hosts: (row.hosts as string[]) ?? [],
    checkMode: row.check_mode as boolean,
    status: row.status as AnsibleRunStatus,
    requestedBy: row.requested_by as string,
    summaries: (row.summaries as AnsibleHostSummary[]) ?? [],
    createdAt: (row.created_at as Date).toISOString(),
    finishedAt: finishedAt ? finishedAt.toISOString() : null,
  };
}

export class AnsibleRunRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateAnsibleRunInput): Promise<AnsibleRun> {
    const result = await this.pool.query(
      `INSERT INTO ansible_runs (run_id, playbook, hosts, check_mode, requested_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.runId, input.playbook, input.hosts, input.checkMode, input.requestedBy],
    );
    return toRun(result.rows[0] as Record<string, unknown>);
  }

  async appendEvent(runId: number, event: AnsibleRunEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO ansible_run_events (run_id, counter, payload) VALUES ($1, $2, $3)`,
      [runId, event.counter, JSON.stringify(event)],
    );
  }

  /**
   * No-ops when the row already reached a terminal status, so a drain that outlives a
   * watchdog timeout cannot resurrect it. Returns whether this call was the one that finished it.
   */
  async finish(
    runId: number,
    status: AnsibleRunStatus,
    summaries: AnsibleHostSummary[],
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ansible_runs
       SET status = $2, summaries = $3, finished_at = NOW()
       WHERE id = $1
         AND status IN ('pending', 'running')
       RETURNING id`,
      [runId, status, JSON.stringify(summaries)],
    );
    return result.rows.length > 0;
  }

  async setStatus(runId: number, status: AnsibleRunStatus): Promise<void> {
    await this.pool.query(`UPDATE ansible_runs SET status = $2 WHERE id = $1`, [runId, status]);
  }

  async findRecent(limit: number): Promise<AnsibleRun[]> {
    const result = await this.pool.query(
      `SELECT * FROM ansible_runs ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => toRun(row as Record<string, unknown>));
  }

  async findByRunId(runId: string): Promise<AnsibleRun | null> {
    const result = await this.pool.query(`SELECT * FROM ansible_runs WHERE run_id = $1`, [runId]);
    return result.rows.length > 0 ? toRun(result.rows[0] as Record<string, unknown>) : null;
  }

  /**
   * Stranded rows from a process that died mid-run. The sidecar keeps no durable state,
   * so a run whose dispatcher is gone has no writer left and can never reach a terminal
   * status on its own. Fails ALL pending/running rows regardless of age, so it is safe
   * only at startup and only when exactly one web process runs against the database.
   */
  async failStrandedRuns(): Promise<StrandedAnsibleRunRow[]> {
    const result = await this.pool.query(
      `UPDATE ansible_runs
       SET status = 'failed', finished_at = NOW()
       WHERE status IN ('pending', 'running')
       RETURNING id, run_id`,
    );
    return result.rows.map((row) => toStrandedRow(row as Record<string, unknown>));
  }

  /** Fails non-terminal runs that have made no progress for thresholdMinutes. Returns the timed-out rows. */
  async timeoutStuckRuns(thresholdMinutes: number): Promise<StrandedAnsibleRunRow[]> {
    // Last event time is a run's only progress signal, so a run still emitting
    // events keeps resetting the clock while a silent one ages out.
    const result = await this.pool.query(
      `UPDATE ansible_runs r
       SET status = 'failed', finished_at = NOW()
       WHERE r.status IN ('pending', 'running')
         AND COALESCE(
               (SELECT MAX(e.at) FROM ansible_run_events e WHERE e.run_id = r.id),
               r.created_at
             ) < NOW() - make_interval(mins => $1)
       RETURNING r.id, r.run_id`,
      [thresholdMinutes],
    );
    return result.rows.map((row) => toStrandedRow(row as Record<string, unknown>));
  }
}

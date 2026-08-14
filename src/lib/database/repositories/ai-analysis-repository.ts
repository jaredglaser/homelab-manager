import type { Pool } from 'pg';
import type {
  AiAlert,
  AiAlertStatus,
  AiAnalysisSession,
  AiContainerProfile,
  AiObservation,
  AiProfileStatus,
  AiSeverity,
} from '@/types/ai';

/** LISTEN channel the web broadcast service subscribes to. */
export const AI_ANALYSIS_NOTIFY_CHANNEL = 'ai_analysis_change';

function toProfile(row: Record<string, unknown>): AiContainerProfile {
  return {
    host: row.host as string,
    containerKey: row.container_key as string,
    enabled: row.enabled as boolean,
    status: row.status as AiProfileStatus,
    skillMarkdown: (row.skill_markdown as string | null) ?? null,
    skillVersion: Number(row.skill_version),
    sampleStartedAt: (row.sample_started_at as Date | null) ?? null,
    sampleEndedAt: (row.sample_ended_at as Date | null) ?? null,
    sampleLineCount: Number(row.sample_line_count),
    model: (row.model as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    updatedAt: row.updated_at as Date,
  };
}

function toSession(row: Record<string, unknown>): AiAnalysisSession {
  const day = row.day as Date | string;
  return {
    id: row.id as string,
    host: row.host as string,
    containerKey: row.container_key as string,
    // pg returns DATE as a Date at local midnight; slicing the ISO string would
    // shift the day west of UTC, so format from the local components instead.
    day: day instanceof Date ? formatDay(day) : String(day),
    status: row.status as AiAnalysisSession['status'],
    startedAt: row.started_at as Date,
    endedAt: (row.ended_at as Date | null) ?? null,
    batchesProcessed: Number(row.batches_processed),
    linesProcessed: Number(row.lines_processed),
    runningSummary: (row.running_summary as string | null) ?? null,
    reportMarkdown: (row.report_markdown as string | null) ?? null,
    model: (row.model as string | null) ?? null,
    error: (row.error as string | null) ?? null,
  };
}

function formatDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const dayOfMonth = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${dayOfMonth}`;
}

function toObservation(row: Record<string, unknown>): AiObservation {
  return {
    id: Number(row.id),
    sessionId: row.session_id as string,
    host: row.host as string,
    containerKey: row.container_key as string,
    at: row.at as Date,
    severity: row.severity as AiSeverity,
    title: row.title as string,
    detail: row.detail as string,
    evidence: (row.evidence as string[] | null) ?? [],
    triaged: row.triaged as boolean,
  };
}

function toAlert(row: Record<string, unknown>): AiAlert {
  return {
    id: Number(row.id),
    at: row.at as Date,
    severity: row.severity as AiSeverity,
    title: row.title as string,
    summary: row.summary as string,
    investigation: (row.investigation as string | null) ?? null,
    entities: (row.entities as string[] | null) ?? [],
    observationIds: ((row.observation_ids as (string | number)[] | null) ?? []).map(Number),
    status: row.status as AiAlertStatus,
  };
}

export interface NewObservation {
  sessionId: string;
  host: string;
  containerKey: string;
  severity: AiSeverity;
  title: string;
  detail: string;
  evidence: string[];
}

export interface NewAlert {
  severity: AiSeverity;
  title: string;
  summary: string;
  investigation: string | null;
  entities: string[];
  observationIds: number[];
}

export class AiAnalysisRepository {
  constructor(private readonly pool: Pool) {}

  async listProfiles(): Promise<AiContainerProfile[]> {
    const result = await this.pool.query(
      'SELECT * FROM ai_container_profiles ORDER BY host ASC, container_key ASC',
    );
    return result.rows.map(toProfile);
  }

  async getProfile(host: string, containerKey: string): Promise<AiContainerProfile | null> {
    const result = await this.pool.query(
      'SELECT * FROM ai_container_profiles WHERE host = $1 AND container_key = $2',
      [host, containerKey],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? toProfile(row) : null;
  }

  /** Registers a container the orchestrator just discovered. Existing rows are left untouched. */
  async ensureProfile(host: string, containerKey: string): Promise<AiContainerProfile> {
    await this.pool.query(
      `INSERT INTO ai_container_profiles (host, container_key)
       VALUES ($1, $2)
       ON CONFLICT (host, container_key) DO NOTHING`,
      [host, containerKey],
    );
    const profile = await this.getProfile(host, containerKey);
    if (!profile) {
      throw new Error(`Profile for ${host}/${containerKey} vanished immediately after insert`);
    }
    return profile;
  }

  async setProfileStatus(
    host: string,
    containerKey: string,
    status: AiProfileStatus,
    error: string | null = null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE ai_container_profiles
       SET status = $3, error = $4, updated_at = now()
       WHERE host = $1 AND container_key = $2`,
      [host, containerKey, status, error],
    );
  }

  async setProfileEnabled(host: string, containerKey: string, enabled: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE ai_container_profiles
       SET enabled = $3, updated_at = now()
       WHERE host = $1 AND container_key = $2`,
      [host, containerKey, enabled],
    );
  }

  async saveSkill(input: {
    host: string;
    containerKey: string;
    skillMarkdown: string;
    model: string;
    sampleStartedAt: Date;
    sampleEndedAt: Date;
    sampleLineCount: number;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE ai_container_profiles
       SET skill_markdown = $3,
           skill_version = skill_version + 1,
           model = $4,
           sample_started_at = $5,
           sample_ended_at = $6,
           sample_line_count = $7,
           status = 'ready',
           error = NULL,
           updated_at = now()
       WHERE host = $1 AND container_key = $2`,
      [
        input.host,
        input.containerKey,
        input.skillMarkdown,
        input.model,
        input.sampleStartedAt,
        input.sampleEndedAt,
        input.sampleLineCount,
      ],
    );
  }

  /**
   * Returns the session for a container's UTC day, creating it on first use.
   * The unique constraint makes this safe against two workers racing on the
   * midnight rollover: the loser's insert is a no-op and it reads the winner's row.
   */
  async openSession(host: string, containerKey: string, day: string, model: string): Promise<AiAnalysisSession> {
    await this.pool.query(
      `INSERT INTO ai_analysis_sessions (host, container_key, day, model)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (host, container_key, day) DO NOTHING`,
      [host, containerKey, day, model],
    );
    const result = await this.pool.query(
      'SELECT * FROM ai_analysis_sessions WHERE host = $1 AND container_key = $2 AND day = $3',
      [host, containerKey, day],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Session for ${host}/${containerKey} on ${day} vanished after insert`);
    return toSession(row);
  }

  async recordBatch(sessionId: string, lineCount: number, runningSummary: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE ai_analysis_sessions
       SET batches_processed = batches_processed + 1,
           lines_processed = lines_processed + $2,
           running_summary = COALESCE($3, running_summary)
       WHERE id = $1`,
      [sessionId, lineCount, runningSummary],
    );
  }

  async closeSession(sessionId: string, reportMarkdown: string): Promise<void> {
    await this.pool.query(
      `UPDATE ai_analysis_sessions
       SET status = 'closed', ended_at = now(), report_markdown = $2, error = NULL
       WHERE id = $1`,
      [sessionId, reportMarkdown],
    );
  }

  async failSession(sessionId: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE ai_analysis_sessions
       SET status = 'failed', ended_at = now(), error = $2
       WHERE id = $1`,
      [sessionId, error],
    );
  }

  async listSessions(limit = 100): Promise<AiAnalysisSession[]> {
    const result = await this.pool.query(
      'SELECT * FROM ai_analysis_sessions ORDER BY started_at DESC LIMIT $1',
      [limit],
    );
    return result.rows.map(toSession);
  }

  async addObservation(input: NewObservation): Promise<AiObservation> {
    const result = await this.pool.query(
      `INSERT INTO ai_observations (session_id, host, container_key, severity, title, detail, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING *`,
      [
        input.sessionId,
        input.host,
        input.containerKey,
        input.severity,
        input.title,
        input.detail,
        JSON.stringify(input.evidence),
      ],
    );
    return toObservation(result.rows[0] as Record<string, unknown>);
  }

  /** Untriaged observations, oldest first: the orchestrator's investigation queue. */
  async claimUntriaged(limit = 25): Promise<AiObservation[]> {
    const result = await this.pool.query(
      `UPDATE ai_observations SET triaged = true
       WHERE id IN (
         SELECT id FROM ai_observations WHERE NOT triaged
         ORDER BY at ASC LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [limit],
    );
    return result.rows.map(toObservation).sort((a, b) => a.at.getTime() - b.at.getTime());
  }

  async listObservations(limit = 200): Promise<AiObservation[]> {
    const result = await this.pool.query(
      'SELECT * FROM ai_observations ORDER BY at DESC LIMIT $1',
      [limit],
    );
    return result.rows.map(toObservation);
  }

  async addAlert(input: NewAlert): Promise<AiAlert> {
    const result = await this.pool.query(
      `INSERT INTO ai_alerts (severity, title, summary, investigation, entities, observation_ids)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.severity,
        input.title,
        input.summary,
        input.investigation,
        input.entities,
        input.observationIds,
      ],
    );
    return toAlert(result.rows[0] as Record<string, unknown>);
  }

  async setAlertStatus(id: number, status: AiAlertStatus): Promise<void> {
    await this.pool.query('UPDATE ai_alerts SET status = $2 WHERE id = $1', [id, status]);
  }

  async listAlerts(limit = 100): Promise<AiAlert[]> {
    const result = await this.pool.query(
      'SELECT * FROM ai_alerts ORDER BY at DESC LIMIT $1',
      [limit],
    );
    return result.rows.map(toAlert);
  }
}

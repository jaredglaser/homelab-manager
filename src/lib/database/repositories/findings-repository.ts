import type { Pool } from 'pg';
import {
  MAX_DETAIL_CHARS,
  MAX_RESOLUTION_CHARS,
  MAX_TITLE_CHARS,
  capEvidence,
  sanitizeBlock,
  sanitizeSingleLine,
  type Finding,
  type FindingEvidence,
  type FindingEvidenceKind,
  type FindingSeverity,
  type FindingStatus,
  type FindingSubjectKind,
  type RawEvidenceInput,
} from '@/lib/findings/types';

// Mirrors MAX_ENTITY_IDS (mcp/tools/findings.ts) and the entity_ids [1:50] slice below.
const MAX_ENTITY_IDS_STORED = 50;
const MAX_INCIDENT_IDS = 20;

export interface RecordFindingInput {
  readonly subjectKind: FindingSubjectKind;
  readonly subjectId: string;
  readonly entityIds: readonly string[];
  readonly fingerprint: string;
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly detail: string;
  readonly evidence: readonly RawEvidenceInput[];
  readonly incidentId: string | null;
  readonly runId: string | null;
  readonly source: 'agent' | 'operator';
  readonly windowFrom: Date | null;
  readonly windowTo: Date | null;
  readonly at: Date;
}

export interface RecordFindingResult {
  readonly finding: Finding;
  readonly created: boolean;
  readonly evidenceDropped: number;
  readonly evidenceTruncated: number;
  readonly detailTruncated: boolean;
}

export interface ListFindingsOptions {
  readonly subjectId?: string;
  readonly entityId?: string;
  readonly fingerprint?: string;
  readonly status?: FindingStatus | 'any';
  readonly severity?: FindingSeverity;
  readonly since?: Date;
  readonly until?: Date;
  readonly limit: number;
}

export interface ResolveFindingInput {
  readonly id: number;
  readonly status: Extract<FindingStatus, 'resolved' | 'dismissed'>;
  readonly resolution: string;
  readonly at: Date;
}

export interface ResolveFindingResult {
  readonly finding: Finding;
  readonly alreadyClosed: boolean;
}

interface FindingDbRow {
  id: string | number;
  subject_kind: FindingSubjectKind;
  subject_id: string;
  entity_ids: string[];
  fingerprint: string;
  severity: FindingSeverity;
  status: FindingStatus;
  title: string;
  detail: string;
  evidence: unknown;
  incident_ids: string[];
  run_id: string | null;
  source: 'agent' | 'operator';
  occurrences: string | number;
  window_from: Date | null;
  window_to: Date | null;
  first_seen_at: Date;
  last_seen_at: Date;
  resolved_at: Date | null;
  resolution: string | null;
}

function isEvidenceItemShape(item: unknown): item is {
  kind: string;
  at: string | null;
  source: string;
  text: string;
  truncated: boolean;
} {
  if (typeof item !== 'object' || item === null) return false;
  const rec = item as Record<string, unknown>;
  return (
    typeof rec.kind === 'string' &&
    (rec.at === null || rec.at === undefined || typeof rec.at === 'string') &&
    typeof rec.source === 'string' &&
    typeof rec.text === 'string' &&
    typeof rec.truncated === 'boolean'
  );
}

function parseEvidence(raw: unknown): FindingEvidence[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isEvidenceItemShape).map((item) => ({
    kind: item.kind as FindingEvidenceKind,
    at: item.at ? new Date(item.at) : null,
    source: item.source,
    text: item.text,
    truncated: item.truncated,
  }));
}

function toFinding(row: FindingDbRow): Finding {
  return {
    id: Number(row.id),
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    entityIds: row.entity_ids,
    fingerprint: row.fingerprint,
    severity: row.severity,
    status: row.status,
    title: row.title,
    detail: row.detail,
    evidence: parseEvidence(row.evidence),
    incidentIds: row.incident_ids,
    runId: row.run_id,
    source: row.source,
    occurrences: Number(row.occurrences),
    windowFrom: row.window_from,
    windowTo: row.window_to,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    resolvedAt: row.resolved_at,
    resolution: row.resolution,
  };
}

function dedupeSorted(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function dedupeSortedCapped(values: readonly string[], max: number): string[] {
  return dedupeSorted(values).slice(0, max);
}

export class FindingsRepository {
  constructor(private readonly pool: Pool) {}

  async record(input: RecordFindingInput): Promise<RecordFindingResult> {
    const { text: title } = sanitizeSingleLine(input.title, MAX_TITLE_CHARS);
    const { text: detail, truncated: detailTruncated } = sanitizeBlock(input.detail, MAX_DETAIL_CHARS);
    const { evidence, dropped: evidenceDropped, truncated: evidenceTruncated } = capEvidence(input.evidence);

    const entityIds = dedupeSortedCapped(input.entityIds, MAX_ENTITY_IDS_STORED);
    const incidentIds = input.incidentId ? [input.incidentId] : [];

    const result = await this.pool.query(
      `INSERT INTO findings (
         subject_kind, subject_id, entity_ids, fingerprint, severity, title, detail, evidence,
         incident_ids, run_id, source, occurrences, window_from, window_to, first_seen_at, last_seen_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, 1, $12, $13, $14, $14)
       ON CONFLICT (subject_kind, subject_id, fingerprint) WHERE status = 'open'
       DO UPDATE SET
         severity = EXCLUDED.severity,
         title = EXCLUDED.title,
         detail = EXCLUDED.detail,
         evidence = EXCLUDED.evidence,
         window_from = EXCLUDED.window_from,
         window_to = EXCLUDED.window_to,
         run_id = EXCLUDED.run_id,
         occurrences = findings.occurrences + 1,
         last_seen_at = EXCLUDED.last_seen_at,
         updated_at = NOW(),
         entity_ids = (
           SELECT COALESCE(array_agg(DISTINCT e ORDER BY e), '{}')
           FROM unnest(findings.entity_ids || EXCLUDED.entity_ids) AS e
         )[1:50],
         incident_ids = (
           -- Dedupe by each id's last position in existing||incoming (not by the id's own
           -- text, which carries no recency signal), then keep the ${MAX_INCIDENT_IDS} most recent.
           SELECT COALESCE(arr[GREATEST(1, cardinality(arr) - ${MAX_INCIDENT_IDS - 1}):cardinality(arr)], '{}')
           FROM (
             SELECT array_agg(i ORDER BY last_ord) AS arr
             FROM (
               SELECT i, MAX(ord) AS last_ord
               FROM unnest(findings.incident_ids || EXCLUDED.incident_ids) WITH ORDINALITY AS t(i, ord)
               GROUP BY i
             ) deduped
           ) merged
         )
       RETURNING *, (xmax = 0) AS created`,
      [
        input.subjectKind,
        input.subjectId,
        entityIds,
        input.fingerprint,
        input.severity,
        title,
        detail,
        JSON.stringify(evidence),
        incidentIds,
        input.runId,
        input.source,
        input.windowFrom,
        input.windowTo,
        input.at,
      ],
    );

    const row = result.rows[0] as FindingDbRow & { created: boolean };
    return {
      finding: toFinding(row),
      created: Boolean(row.created),
      evidenceDropped,
      evidenceTruncated,
      detailTruncated,
    };
  }

  async getById(id: number): Promise<Finding | null> {
    const result = await this.pool.query(`SELECT * FROM findings WHERE id = $1`, [id]);
    if (result.rows.length === 0) return null;
    return toFinding(result.rows[0] as FindingDbRow);
  }

  async list(options: ListFindingsOptions): Promise<Finding[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (options.subjectId !== undefined) {
      conditions.push(`subject_id = $${idx++}`);
      params.push(options.subjectId);
    }
    if (options.entityId !== undefined) {
      conditions.push(`$${idx++} = ANY(entity_ids)`);
      params.push(options.entityId);
    }
    if (options.fingerprint !== undefined) {
      conditions.push(`fingerprint = $${idx++}`);
      params.push(options.fingerprint);
    }
    if (options.status !== undefined && options.status !== 'any') {
      conditions.push(`status = $${idx++}`);
      params.push(options.status);
    }
    if (options.severity !== undefined) {
      conditions.push(`severity = $${idx++}`);
      params.push(options.severity);
    }
    if (options.since !== undefined) {
      conditions.push(`last_seen_at >= $${idx++}`);
      params.push(options.since);
    }
    if (options.until !== undefined) {
      conditions.push(`last_seen_at <= $${idx++}`);
      params.push(options.until);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(options.limit);

    const result = await this.pool.query(
      `SELECT * FROM findings ${where} ORDER BY last_seen_at DESC LIMIT $${idx}`,
      params,
    );
    return result.rows.map((row) => toFinding(row as FindingDbRow));
  }

  async listRecent(limit: number): Promise<Finding[]> {
    const result = await this.pool.query(
      `SELECT * FROM findings ORDER BY (status = 'open') DESC, last_seen_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => toFinding(row as FindingDbRow));
  }

  async resolve(input: ResolveFindingInput): Promise<ResolveFindingResult | null> {
    const { text: resolution } = sanitizeBlock(input.resolution, MAX_RESOLUTION_CHARS);

    const updated = await this.pool.query(
      `UPDATE findings
       SET status = $2, resolution = $3, resolved_at = $4, updated_at = NOW()
       WHERE id = $1 AND status = 'open'
       RETURNING *`,
      [input.id, input.status, resolution, input.at],
    );
    if (updated.rows.length > 0) {
      return { finding: toFinding(updated.rows[0] as FindingDbRow), alreadyClosed: false };
    }

    const existing = await this.pool.query(`SELECT * FROM findings WHERE id = $1`, [input.id]);
    if (existing.rows.length === 0) return null;
    return { finding: toFinding(existing.rows[0] as FindingDbRow), alreadyClosed: true };
  }
}

import type { Pool } from 'pg';
import type { FindingSeverity, FindingStatus, FindingSubjectKind } from '@/lib/findings/types';
import {
  OPERATOR_VERDICTS,
  FEEDBACK_VERDICTS,
  LABEL_SOURCES,
  IMPLICIT_SIGNALS,
  CONFOUNDERS,
  MAX_LABEL_NOTE_CHARS,
} from '@/lib/feedback/types';
import type {
  OperatorVerdict,
  FeedbackVerdict,
  LabelSource,
  ImplicitSignal,
  Confounder,
  LabelEvidence,
  FindingLabel,
  FindingVerdictSummary,
  WeakSignalSummary,
  InsertLabelInput,
  ImplicitCandidate,
  ListImplicitCandidatesInput,
} from '@/lib/feedback/types';

// Re-exported for existing callers: @/lib/feedback/types is the source of truth (spec section
// G), but this repository predates that module, so its own imports keep working unchanged.
export {
  OPERATOR_VERDICTS,
  FEEDBACK_VERDICTS,
  LABEL_SOURCES,
  IMPLICIT_SIGNALS,
  CONFOUNDERS,
  MAX_LABEL_NOTE_CHARS,
};
export type {
  OperatorVerdict,
  FeedbackVerdict,
  LabelSource,
  ImplicitSignal,
  Confounder,
  LabelEvidence,
  FindingLabel,
  FindingVerdictSummary,
  WeakSignalSummary,
  InsertLabelInput,
  ImplicitCandidate,
  ListImplicitCandidatesInput,
};

interface FindingLabelDbRow {
  id: string | number;
  finding_id: string | number;
  verdict: FeedbackVerdict;
  source: LabelSource;
  weight: number | string;
  signal: ImplicitSignal | null;
  basis_at: Date | null;
  confounders: string[] | null;
  evidence: unknown;
  duplicate_of_finding_id: string | number | null;
  note: string;
  labeled_by: string | null;
  labeled_at: Date;
  supersedes_label_id: string | number | null;
}

interface CurrentVerdictDbRow {
  finding_id: string | number;
  verdict: OperatorVerdict;
  source: Exclude<LabelSource, 'implicit'>;
  note: string;
  duplicate_of_finding_id: string | number | null;
  labeled_by: string | null;
  labeled_at: Date;
  explicit_count: string | number;
}

interface WeakSignalDbRow {
  finding_id: string | number;
  actionable_weight: number | string | null;
  noise_weight: number | string | null;
  signal_count: string | number;
  signals: (string | null)[] | null;
  confounders: (string | null)[] | null;
  last_inferred_at: Date;
}

interface ImplicitCandidateDbRow {
  id: string | number;
  subject_kind: FindingSubjectKind;
  subject_id: string;
  entity_ids: string[];
  severity: FindingSeverity;
  status: FindingStatus;
  title: string;
  detail: string;
  last_seen_at: Date;
  window_from: Date | null;
  window_to: Date | null;
  evaluated_signals: (string | null)[] | null;
}

function isLabelEvidence(item: unknown): item is LabelEvidence {
  if (typeof item !== 'object' || item === null) return false;
  const rec = item as Record<string, unknown>;
  return (
    (rec.kind === 'container_event' || rec.kind === 'deploy' || rec.kind === 'absence') &&
    (rec.at === null || rec.at === undefined || typeof rec.at === 'string') &&
    typeof rec.ref === 'string' &&
    typeof rec.detail === 'string'
  );
}

function parseEvidence(raw: unknown): LabelEvidence[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isLabelEvidence).map((item) => ({
    kind: item.kind,
    at: item.at ?? null,
    ref: item.ref,
    detail: item.detail,
  }));
}

function toFindingLabel(row: FindingLabelDbRow): FindingLabel {
  return {
    id: Number(row.id),
    findingId: Number(row.finding_id),
    verdict: row.verdict,
    source: row.source,
    weight: Number(row.weight),
    signal: row.signal,
    basisAt: row.basis_at,
    confounders: (row.confounders ?? []) as Confounder[],
    evidence: parseEvidence(row.evidence),
    duplicateOfFindingId: row.duplicate_of_finding_id === null ? null : Number(row.duplicate_of_finding_id),
    note: row.note,
    labeledBy: row.labeled_by,
    labeledAt: row.labeled_at,
    supersedesLabelId: row.supersedes_label_id === null ? null : Number(row.supersedes_label_id),
  };
}

function toVerdictSummary(row: CurrentVerdictDbRow): FindingVerdictSummary {
  return {
    findingId: Number(row.finding_id),
    verdict: row.verdict,
    source: row.source,
    note: row.note,
    duplicateOfFindingId: row.duplicate_of_finding_id === null ? null : Number(row.duplicate_of_finding_id),
    labeledBy: row.labeled_by,
    labeledAt: row.labeled_at,
    relabelCount: Math.max(0, Number(row.explicit_count) - 1),
  };
}

function toWeakSignalSummary(row: WeakSignalDbRow): WeakSignalSummary {
  return {
    findingId: Number(row.finding_id),
    actionableWeight: row.actionable_weight === null ? 0 : Number(row.actionable_weight),
    noiseWeight: row.noise_weight === null ? 0 : Number(row.noise_weight),
    signalCount: Number(row.signal_count),
    signals: (row.signals ?? []).filter((s): s is ImplicitSignal => s !== null),
    confounders: (row.confounders ?? []).filter((c): c is Confounder => c !== null),
    lastInferredAt: row.last_inferred_at,
  };
}

function splitSubjectId(subjectKind: FindingSubjectKind, subjectId: string): { host: string; stackProject: string | null } {
  const slash = subjectId.indexOf('/');
  if (slash === -1) return { host: subjectId, stackProject: null };
  const host = subjectId.slice(0, slash);
  return { host, stackProject: subjectKind === 'stack' ? subjectId.slice(slash + 1) : null };
}

function toImplicitCandidate(row: ImplicitCandidateDbRow): ImplicitCandidate {
  const { host, stackProject } = splitSubjectId(row.subject_kind, row.subject_id);
  return {
    findingId: Number(row.id),
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    entityIds: row.entity_ids,
    host,
    stackProject,
    severity: row.severity,
    status: row.status,
    title: row.title,
    detail: row.detail,
    lastSeenAt: row.last_seen_at,
    windowFrom: row.window_from,
    windowTo: row.window_to,
    evaluatedSignals: (row.evaluated_signals ?? []).filter((s): s is ImplicitSignal => s !== null),
  };
}

const LABEL_COLUMNS = `id, finding_id, verdict, source, weight, signal, basis_at, confounders, evidence,
       duplicate_of_finding_id, note, labeled_by, labeled_at, supersedes_label_id`;

export class FindingLabelRepository {
  constructor(private readonly pool: Pool) {}

  async insert(input: InsertLabelInput): Promise<FindingLabel> {
    const result = await this.pool.query(
      `INSERT INTO finding_labels (
         finding_id, verdict, source, weight, signal, basis_at, confounders, evidence,
         duplicate_of_finding_id, note, labeled_by, supersedes_label_id, labeled_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, COALESCE($13, NOW()))
       RETURNING ${LABEL_COLUMNS}`,
      [
        input.findingId,
        input.verdict,
        input.source,
        input.weight,
        input.signal ?? null,
        input.basisAt ?? null,
        (input.confounders ?? []) as string[],
        JSON.stringify(input.evidence ?? []),
        input.duplicateOfFindingId ?? null,
        input.note ?? '',
        input.labeledBy,
        input.supersedesLabelId ?? null,
        input.at ?? null,
      ],
    );
    return toFindingLabel(result.rows[0] as FindingLabelDbRow);
  }

  async insertMany(inputs: readonly InsertLabelInput[]): Promise<number> {
    if (inputs.length === 0) return 0;

    const params: unknown[] = [];
    const rowsSql: string[] = [];
    for (const input of inputs) {
      const base = params.length;
      params.push(
        input.findingId,
        input.verdict,
        input.source,
        input.weight,
        input.signal ?? null,
        input.basisAt ?? null,
        (input.confounders ?? []) as string[],
        JSON.stringify(input.evidence ?? []),
        input.duplicateOfFindingId ?? null,
        input.note ?? '',
        input.labeledBy,
        input.supersedesLabelId ?? null,
        input.at ?? null,
      );
      rowsSql.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}::jsonb, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, COALESCE($${base + 13}, NOW()))`,
      );
    }

    const result = await this.pool.query(
      `INSERT INTO finding_labels (
         finding_id, verdict, source, weight, signal, basis_at, confounders, evidence,
         duplicate_of_finding_id, note, labeled_by, supersedes_label_id, labeled_at
       ) VALUES ${rowsSql.join(', ')}
       ON CONFLICT (finding_id, signal, basis_at) WHERE source = 'implicit' DO NOTHING
       RETURNING id`,
      params,
    );
    return result.rows.length;
  }

  async listForFinding(findingId: number, limit = 100): Promise<FindingLabel[]> {
    const result = await this.pool.query(
      `SELECT ${LABEL_COLUMNS} FROM finding_labels
       WHERE finding_id = $1
       ORDER BY labeled_at DESC, id DESC
       LIMIT $2`,
      [findingId, limit],
    );
    return (result.rows as FindingLabelDbRow[]).map(toFindingLabel);
  }

  async currentForFindings(findingIds: readonly number[]): Promise<Map<number, FindingVerdictSummary>> {
    const map = new Map<number, FindingVerdictSummary>();
    if (findingIds.length === 0) return map;

    const result = await this.pool.query(
      `SELECT c.finding_id, c.verdict, c.source, c.note, c.duplicate_of_finding_id, c.labeled_by, c.labeled_at,
              cnt.explicit_count
       FROM finding_label_current c
       JOIN (
         SELECT finding_id, COUNT(*) AS explicit_count
         FROM finding_labels
         WHERE source IN ('operator', 'agent') AND finding_id = ANY($1)
         GROUP BY finding_id
       ) cnt ON cnt.finding_id = c.finding_id
       WHERE c.finding_id = ANY($1)`,
      [findingIds as number[]],
    );
    for (const row of result.rows as CurrentVerdictDbRow[]) {
      const summary = toVerdictSummary(row);
      map.set(summary.findingId, summary);
    }
    return map;
  }

  async weakSignalsForFindings(findingIds: readonly number[]): Promise<Map<number, WeakSignalSummary>> {
    const map = new Map<number, WeakSignalSummary>();
    if (findingIds.length === 0) return map;

    const result = await this.pool.query(
      `SELECT finding_id, actionable_weight, noise_weight, signal_count, signals, confounders, last_inferred_at
       FROM finding_weak_signals
       WHERE finding_id = ANY($1)`,
      [findingIds as number[]],
    );
    for (const row of result.rows as WeakSignalDbRow[]) {
      const summary = toWeakSignalSummary(row);
      map.set(summary.findingId, summary);
    }
    return map;
  }

  async currentSince(since: Date, until: Date): Promise<FindingVerdictSummary[]> {
    const result = await this.pool.query(
      `SELECT c.finding_id, c.verdict, c.source, c.note, c.duplicate_of_finding_id, c.labeled_by, c.labeled_at,
              cnt.explicit_count
       FROM finding_label_current c
       JOIN (
         SELECT finding_id, COUNT(*) AS explicit_count
         FROM finding_labels
         WHERE source IN ('operator', 'agent')
         GROUP BY finding_id
       ) cnt ON cnt.finding_id = c.finding_id
       WHERE c.labeled_at >= $1 AND c.labeled_at < $2
       ORDER BY c.labeled_at DESC`,
      [since, until],
    );
    return (result.rows as CurrentVerdictDbRow[]).map(toVerdictSummary);
  }

  async hasOperatorLabel(findingId: number): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM finding_labels WHERE finding_id = $1 AND source = 'operator' LIMIT 1`,
      [findingId],
    );
    return result.rows.length > 0;
  }

  // quietBefore is not a separate WHERE bound: it is always earlier than settledBefore (24h of
  // quiet vs. a ~65m settle slack), so `last_seen_at <= settledBefore` already covers every
  // quiet_24h-eligible row. Newly-eligible-for-quiet-24h candidates are told apart from
  // already-evaluated ones by evaluatedSignals, in the pure inferImplicitLabels, not here.
  async listImplicitCandidates(input: ListImplicitCandidatesInput): Promise<ImplicitCandidate[]> {
    const result = await this.pool.query(
      `SELECT f.id, f.subject_kind, f.subject_id, f.entity_ids, f.severity, f.status, f.title, f.detail,
              f.last_seen_at, f.window_from, f.window_to,
              COALESCE(
                array_agg(DISTINCT l.signal) FILTER (WHERE l.signal IS NOT NULL AND l.basis_at = f.last_seen_at),
                '{}'
              ) AS evaluated_signals
       FROM findings f
       LEFT JOIN finding_labels l ON l.finding_id = f.id AND l.source = 'implicit'
       WHERE f.source = 'agent'
         AND f.last_seen_at <= $1
         AND f.last_seen_at >= $2
         AND NOT EXISTS (
           SELECT 1 FROM finding_labels o WHERE o.finding_id = f.id AND o.source = 'operator'
         )
       GROUP BY f.id
       ORDER BY f.last_seen_at ASC
       LIMIT $3`,
      [input.settledBefore, input.notOlderThan, input.limit],
    );
    return (result.rows as ImplicitCandidateDbRow[]).map(toImplicitCandidate);
  }
}

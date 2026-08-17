import type { Pool } from 'pg';
import type { FindingSeverity, FindingStatus } from '@/lib/findings/types';
import type { LogLane } from '@/lib/database/repositories/log-shape-repository';
import type { OperatorVerdict } from '@/lib/database/repositories/finding-label-repository';
import { MISS_STATUSES, ATTRIBUTION_VERDICTS, MAX_MISS_DESCRIPTION_CHARS, MAX_MISS_ENTITY_IDS } from '@/lib/feedback/types';
import type { MissStatus, AttributionVerdict, ReportedMiss, CreateReportedMissInput, ListMissesOptions, JsonValue } from '@/lib/feedback/types';

// Re-exported for existing callers: @/lib/feedback/types is the source of truth (spec section
// G), but this repository predates that module, so its own imports keep working unchanged.
export { MISS_STATUSES, ATTRIBUTION_VERDICTS, MAX_MISS_ENTITY_IDS };
export { MAX_MISS_DESCRIPTION_CHARS as MAX_MISS_WHAT_HAPPENED_CHARS };
export type { MissStatus, AttributionVerdict, ReportedMiss, CreateReportedMissInput, ListMissesOptions, JsonValue };

export type IncidentScope = 'container' | 'stack' | 'host';
export type IncidentLane = 'page' | 'triage';
export type IncidentState = 'open' | 'dispatched' | 'closed';
export type DispatchOutcome =
  | 'accepted'
  | 'duplicate'
  | 'rate-limited'
  | 'rejected'
  | 'transport'
  | 'circuit-open'
  | 'budget-exhausted'
  | 'queue-dropped'
  | 'disabled'
  | 'cooldown'
  | 'page-sent';

const DROPPED_DISPATCH_OUTCOMES = new Set<DispatchOutcome>([
  'budget-exhausted',
  'queue-dropped',
  'rate-limited',
  'circuit-open',
  'transport',
  'disabled',
  'cooldown',
  'duplicate',
  'rejected',
]);
const DELIVERED_DISPATCH_OUTCOMES = new Set<DispatchOutcome>(['accepted', 'page-sent']);

interface ReportedMissDbRow {
  id: string | number;
  window_from: Date;
  window_to: Date;
  entity_ids: string[];
  host: string | null;
  stack_project: string | null;
  what_happened: string;
  severity: FindingSeverity;
  status: MissStatus;
  attribution: JsonValue;
  attribution_verdict: AttributionVerdict | null;
  attributed_at: Date | null;
  matched_finding_ids: (string | number)[] | null;
  matched_incident_ids: string[] | null;
  reported_by: string;
  reported_at: Date;
  note: string;
  updated_at: Date;
}

function toReportedMiss(row: ReportedMissDbRow): ReportedMiss {
  return {
    id: Number(row.id),
    windowFrom: row.window_from,
    windowTo: row.window_to,
    entityIds: row.entity_ids,
    host: row.host,
    stackProject: row.stack_project,
    whatHappened: row.what_happened,
    severity: row.severity,
    status: row.status,
    attribution: row.attribution,
    attributionVerdict: row.attribution_verdict,
    attributedAt: row.attributed_at,
    matchedFindingIds: (row.matched_finding_ids ?? []).map(Number),
    matchedIncidentIds: row.matched_incident_ids ?? [],
    reportedBy: row.reported_by,
    reportedAt: row.reported_at,
    note: row.note,
    updatedAt: row.updated_at,
  };
}

const MISS_COLUMNS = `id, window_from, window_to, entity_ids, host, stack_project, what_happened, severity,
       status, attribution, attribution_verdict, attributed_at, matched_finding_ids,
       matched_incident_ids, reported_by, reported_at, note, updated_at`;

function zeroCountRecord<K extends string>(keys: readonly K[]): Record<K, number> {
  const record = {} as Record<K, number>;
  for (const key of keys) record[key] = 0;
  return record;
}

export class ReportedMissRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateReportedMissInput): Promise<ReportedMiss> {
    const result = await this.pool.query(
      `INSERT INTO reported_misses (
         window_from, window_to, entity_ids, host, stack_project, what_happened, severity,
         reported_by, note
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${MISS_COLUMNS}`,
      [
        input.windowFrom,
        input.windowTo,
        input.entityIds as string[],
        input.host ?? null,
        input.stackProject ?? null,
        input.whatHappened,
        input.severity,
        input.reportedBy,
        input.note ?? '',
      ],
    );
    return toReportedMiss(result.rows[0] as ReportedMissDbRow);
  }

  async getById(id: number): Promise<ReportedMiss | null> {
    const result = await this.pool.query(`SELECT ${MISS_COLUMNS} FROM reported_misses WHERE id = $1`, [id]);
    if (result.rows.length === 0) return null;
    return toReportedMiss(result.rows[0] as ReportedMissDbRow);
  }

  async list(options: ListMissesOptions): Promise<ReportedMiss[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (options.windowFrom !== undefined) {
      conditions.push(`window_from >= $${idx++}`);
      params.push(options.windowFrom);
    }
    if (options.windowTo !== undefined) {
      conditions.push(`window_to <= $${idx++}`);
      params.push(options.windowTo);
    }
    if (options.entityId !== undefined) {
      conditions.push(`$${idx++} = ANY(entity_ids)`);
      params.push(options.entityId);
    }
    if (options.status !== undefined) {
      conditions.push(`status = $${idx++}`);
      params.push(options.status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(options.limit);

    const result = await this.pool.query(
      `SELECT ${MISS_COLUMNS} FROM reported_misses ${where} ORDER BY reported_at DESC LIMIT $${idx}`,
      params,
    );
    return (result.rows as ReportedMissDbRow[]).map(toReportedMiss);
  }

  async saveAttribution(
    id: number,
    verdict: AttributionVerdict,
    attribution: unknown,
    findingIds: readonly number[],
    incidentIds: readonly string[],
    at: Date,
  ): Promise<ReportedMiss | null> {
    const result = await this.pool.query(
      `UPDATE reported_misses
       SET attribution = $2::jsonb,
           attribution_verdict = $3,
           attributed_at = $4,
           matched_finding_ids = $5,
           matched_incident_ids = $6,
           status = CASE WHEN status = 'new' THEN 'attributed' ELSE status END,
           updated_at = NOW()
       WHERE id = $1
       RETURNING ${MISS_COLUMNS}`,
      [id, JSON.stringify(attribution), verdict, at, findingIds as number[], incidentIds as string[]],
    );
    if (result.rows.length === 0) return null;
    return toReportedMiss(result.rows[0] as ReportedMissDbRow);
  }

  async setStatus(id: number, status: MissStatus, note: string): Promise<ReportedMiss | null> {
    const result = await this.pool.query(
      `UPDATE reported_misses SET status = $2, note = $3, updated_at = NOW() WHERE id = $1
       RETURNING ${MISS_COLUMNS}`,
      [id, status, note],
    );
    if (result.rows.length === 0) return null;
    return toReportedMiss(result.rows[0] as ReportedMissDbRow);
  }

  async countByStatus(from: Date, to: Date): Promise<Record<MissStatus, number>> {
    const counts = zeroCountRecord(MISS_STATUSES);
    const result = await this.pool.query(
      `SELECT status, COUNT(*) AS n FROM reported_misses
       WHERE window_from >= $1 AND window_from < $2 AND status <> 'invalid'
       GROUP BY status`,
      [from, to],
    );
    for (const row of result.rows as { status: MissStatus; n: string | number }[]) {
      counts[row.status] = Number(row.n);
    }
    return counts;
  }

  async countByAttributionVerdict(from: Date, to: Date): Promise<Record<AttributionVerdict, number>> {
    const counts = zeroCountRecord(ATTRIBUTION_VERDICTS);
    const result = await this.pool.query(
      `SELECT attribution_verdict, COUNT(*) AS n FROM reported_misses
       WHERE window_from >= $1 AND window_from < $2 AND attribution_verdict IS NOT NULL AND status <> 'invalid'
       GROUP BY attribution_verdict`,
      [from, to],
    );
    for (const row of result.rows as { attribution_verdict: AttributionVerdict; n: string | number }[]) {
      counts[row.attribution_verdict] = Number(row.n);
    }
    return counts;
  }
}

export interface IncidentSignalSummary {
  readonly at: string;
  readonly trigger: string;
  readonly lane: string;
  readonly decidingRuleId: string | null;
  readonly shapeId: string | null;
  readonly lineCount: number;
  readonly stderrCount: number;
  readonly baselineZ: number | null;
}

export interface IncidentRecordInput {
  readonly id: string;
  readonly scope: IncidentScope;
  readonly scopeKey: string;
  readonly host: string;
  readonly stackProject: string | null;
  readonly primaryEntityId: string;
  readonly entityIds: readonly string[];
  readonly tier: 0 | 1 | 2;
  readonly lane: IncidentLane;
  readonly state: IncidentState;
  readonly occurrence: number;
  readonly signalCount: number;
  readonly openedAt: Date;
  readonly firstSignalAt: Date;
  readonly lastSignalAt: Date;
  readonly dispatchedAt: Date | null;
  readonly dispatchOutcome: DispatchOutcome | null;
  readonly dispatchDetail: string;
  readonly latencyMs: number | null;
  readonly decidingRuleId: string | null;
  readonly ruleIds: readonly string[];
  readonly shapeIds: readonly string[];
  readonly hardSignal: boolean;
  readonly signals: readonly IncidentSignalSummary[];
  readonly mergedFrom: readonly string[];
}

export interface IncidentRecord {
  readonly id: string;
  readonly scope: IncidentScope;
  readonly scopeKey: string;
  readonly host: string;
  readonly stackProject: string | null;
  readonly primaryEntityId: string;
  readonly entityIds: string[];
  readonly tier: 0 | 1 | 2;
  readonly lane: IncidentLane;
  readonly state: IncidentState;
  readonly occurrence: number;
  readonly signalCount: number;
  readonly openedAt: Date;
  readonly firstSignalAt: Date;
  readonly lastSignalAt: Date;
  readonly dispatchedAt: Date | null;
  readonly dispatchOutcome: DispatchOutcome | null;
  readonly dispatchDetail: string;
  readonly delivered: boolean;
  readonly latencyMs: number | null;
  readonly decidingRuleId: string | null;
  readonly ruleIds: string[];
  readonly shapeIds: string[];
  readonly hardSignal: boolean;
  readonly signals: IncidentSignalSummary[];
  readonly mergedFrom: string[];
  readonly findingIds: number[];
}

export interface ListIncidentsOptions {
  readonly incidentId?: string;
  readonly entityId?: string;
  readonly host?: string;
  readonly stackProject?: string;
  readonly lane?: IncidentLane;
  readonly tier?: 0 | 1 | 2;
  readonly dispatched?: 'any' | 'delivered' | 'undelivered';
  readonly since?: Date;
  readonly until?: Date;
  readonly limit: number;
}

interface IncidentDbRow {
  id: string;
  scope: IncidentScope;
  scope_key: string;
  host: string;
  stack_project: string | null;
  primary_entity_id: string;
  entity_ids: string[];
  tier: number;
  lane: IncidentLane;
  state: IncidentState;
  occurrence: number;
  signal_count: number;
  opened_at: Date;
  first_signal_at: Date;
  last_signal_at: Date;
  dispatched_at: Date | null;
  dispatch_outcome: DispatchOutcome | null;
  dispatch_detail: string;
  latency_ms: number | null;
  deciding_rule_id: string | null;
  rule_ids: string[];
  shape_ids: string[];
  hard_signal: boolean;
  signals: unknown;
  merged_from: string[];
  finding_ids?: (string | number)[] | null;
}

function toIncidentRecord(row: IncidentDbRow): IncidentRecord {
  return {
    id: row.id,
    scope: row.scope,
    scopeKey: row.scope_key,
    host: row.host,
    stackProject: row.stack_project,
    primaryEntityId: row.primary_entity_id,
    entityIds: row.entity_ids,
    tier: row.tier as 0 | 1 | 2,
    lane: row.lane,
    state: row.state,
    occurrence: Number(row.occurrence),
    signalCount: Number(row.signal_count),
    openedAt: row.opened_at,
    firstSignalAt: row.first_signal_at,
    lastSignalAt: row.last_signal_at,
    dispatchedAt: row.dispatched_at,
    dispatchOutcome: row.dispatch_outcome,
    dispatchDetail: row.dispatch_detail,
    delivered: row.dispatch_outcome !== null && DELIVERED_DISPATCH_OUTCOMES.has(row.dispatch_outcome),
    latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
    decidingRuleId: row.deciding_rule_id,
    ruleIds: row.rule_ids,
    shapeIds: row.shape_ids,
    hardSignal: row.hard_signal,
    signals: (row.signals ?? []) as IncidentSignalSummary[],
    mergedFrom: row.merged_from,
    findingIds: (row.finding_ids ?? []).map(Number),
  };
}

const INCIDENT_COLUMNS = `id, scope, scope_key, host, stack_project, primary_entity_id, entity_ids, tier, lane,
       state, occurrence, signal_count, opened_at, first_signal_at, last_signal_at,
       dispatched_at, dispatch_outcome, dispatch_detail, latency_ms,
       deciding_rule_id, rule_ids, shape_ids, hard_signal, signals, merged_from`;

const INCIDENT_COLUMNS_WITH_FINDINGS = `${INCIDENT_COLUMNS},
       (SELECT COALESCE(array_agg(f.id), '{}') FROM findings f WHERE f.incident_ids @> ARRAY[i.id]) AS finding_ids`;

export class IncidentRepository {
  constructor(private readonly pool: Pool) {}

  async upsert(input: IncidentRecordInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO incidents (
         id, scope, scope_key, host, stack_project, primary_entity_id, entity_ids, tier, lane, state,
         occurrence, signal_count, opened_at, first_signal_at, last_signal_at,
         dispatched_at, dispatch_outcome, dispatch_detail, latency_ms,
         deciding_rule_id, rule_ids, shape_ids, hard_signal, signals, merged_from
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15,
         $16, $17, $18, $19,
         $20, $21, $22, $23, $24::jsonb, $25
       )
       ON CONFLICT (id) DO UPDATE SET
         scope = EXCLUDED.scope,
         scope_key = EXCLUDED.scope_key,
         host = EXCLUDED.host,
         stack_project = EXCLUDED.stack_project,
         primary_entity_id = EXCLUDED.primary_entity_id,
         entity_ids = EXCLUDED.entity_ids,
         tier = EXCLUDED.tier,
         lane = EXCLUDED.lane,
         state = EXCLUDED.state,
         occurrence = EXCLUDED.occurrence,
         signal_count = EXCLUDED.signal_count,
         first_signal_at = LEAST(incidents.first_signal_at, EXCLUDED.first_signal_at),
         last_signal_at = GREATEST(incidents.last_signal_at, EXCLUDED.last_signal_at),
         dispatched_at = COALESCE(EXCLUDED.dispatched_at, incidents.dispatched_at),
         dispatch_outcome = COALESCE(EXCLUDED.dispatch_outcome, incidents.dispatch_outcome),
         dispatch_detail = CASE WHEN EXCLUDED.dispatch_outcome IS NOT NULL THEN EXCLUDED.dispatch_detail ELSE incidents.dispatch_detail END,
         latency_ms = COALESCE(EXCLUDED.latency_ms, incidents.latency_ms),
         deciding_rule_id = COALESCE(EXCLUDED.deciding_rule_id, incidents.deciding_rule_id),
         rule_ids = EXCLUDED.rule_ids,
         shape_ids = EXCLUDED.shape_ids,
         hard_signal = EXCLUDED.hard_signal,
         signals = EXCLUDED.signals,
         merged_from = EXCLUDED.merged_from,
         updated_at = NOW()`,
      [
        input.id,
        input.scope,
        input.scopeKey,
        input.host,
        input.stackProject,
        input.primaryEntityId,
        input.entityIds as string[],
        input.tier,
        input.lane,
        input.state,
        input.occurrence,
        input.signalCount,
        input.openedAt,
        input.firstSignalAt,
        input.lastSignalAt,
        input.dispatchedAt,
        input.dispatchOutcome,
        input.dispatchDetail,
        input.latencyMs,
        input.decidingRuleId,
        input.ruleIds as string[],
        input.shapeIds as string[],
        input.hardSignal,
        JSON.stringify(input.signals),
        input.mergedFrom as string[],
      ],
    );
  }

  async getById(id: string): Promise<IncidentRecord | null> {
    const result = await this.pool.query(
      `SELECT ${INCIDENT_COLUMNS_WITH_FINDINGS} FROM incidents i WHERE i.id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return toIncidentRecord(result.rows[0] as IncidentDbRow);
  }

  async list(options: ListIncidentsOptions): Promise<IncidentRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (options.incidentId !== undefined) {
      conditions.push(`i.id = $${idx++}`);
      params.push(options.incidentId);
    }
    if (options.entityId !== undefined) {
      conditions.push(`$${idx++} = ANY(i.entity_ids)`);
      params.push(options.entityId);
    }
    if (options.host !== undefined) {
      conditions.push(`i.host = $${idx++}`);
      params.push(options.host);
    }
    if (options.stackProject !== undefined) {
      conditions.push(`i.stack_project = $${idx++}`);
      params.push(options.stackProject);
    }
    if (options.lane !== undefined) {
      conditions.push(`i.lane = $${idx++}`);
      params.push(options.lane);
    }
    if (options.tier !== undefined) {
      conditions.push(`i.tier = $${idx++}`);
      params.push(options.tier);
    }
    if (options.dispatched === 'delivered') {
      conditions.push(`i.dispatch_outcome = ANY($${idx++})`);
      params.push([...DELIVERED_DISPATCH_OUTCOMES]);
    } else if (options.dispatched === 'undelivered') {
      conditions.push(`(i.dispatch_outcome IS NULL OR i.dispatch_outcome <> ALL($${idx++}))`);
      params.push([...DELIVERED_DISPATCH_OUTCOMES]);
    }
    if (options.since !== undefined) {
      conditions.push(`i.first_signal_at >= $${idx++}`);
      params.push(options.since);
    }
    if (options.until !== undefined) {
      conditions.push(`i.first_signal_at <= $${idx++}`);
      params.push(options.until);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(options.limit);

    const result = await this.pool.query(
      `SELECT ${INCIDENT_COLUMNS_WITH_FINDINGS} FROM incidents i ${where}
       ORDER BY i.first_signal_at DESC LIMIT $${idx}`,
      params,
    );
    return (result.rows as IncidentDbRow[]).map(toIncidentRecord);
  }

  async listForWindow(entityIds: readonly string[], from: Date, to: Date): Promise<IncidentRecord[]> {
    if (entityIds.length === 0) return [];
    const result = await this.pool.query(
      `SELECT ${INCIDENT_COLUMNS_WITH_FINDINGS} FROM incidents i
       WHERE i.entity_ids && $1 AND i.last_signal_at >= $2 AND i.first_signal_at <= $3
       ORDER BY i.first_signal_at DESC`,
      [entityIds as string[], from, to],
    );
    return (result.rows as IncidentDbRow[]).map(toIncidentRecord);
  }

  async tierZeroLatencies(from: Date, to: Date): Promise<{ latencies: number[]; neverDispatched: Record<string, number> }> {
    const latencyResult = await this.pool.query(
      `SELECT latency_ms FROM incidents
       WHERE tier = 0 AND dispatched_at IS NOT NULL AND latency_ms IS NOT NULL
         AND first_signal_at >= $1 AND first_signal_at < $2
       ORDER BY first_signal_at ASC`,
      [from, to],
    );
    const latencies = (latencyResult.rows as { latency_ms: number | string }[]).map((row) => Number(row.latency_ms));

    const neverDispatchedResult = await this.pool.query(
      `SELECT dispatch_outcome, COUNT(*) AS n FROM incidents
       WHERE tier = 0 AND dispatched_at IS NULL
         AND first_signal_at >= $1 AND first_signal_at < $2
       GROUP BY dispatch_outcome`,
      [from, to],
    );
    const neverDispatched: Record<string, number> = {};
    for (const row of neverDispatchedResult.rows as { dispatch_outcome: DispatchOutcome | null; n: string | number }[]) {
      neverDispatched[row.dispatch_outcome ?? 'none'] = Number(row.n);
    }

    return { latencies, neverDispatched };
  }

  async prune(olderThan: Date): Promise<number> {
    const result = await this.pool.query(`DELETE FROM incidents WHERE first_signal_at < $1`, [olderThan]);
    return result.rowCount ?? 0;
  }
}

export interface MissAttributionInput {
  readonly windowFrom: Date;
  readonly windowTo: Date;
  readonly entityIds: readonly string[];
}

export interface AttributionFindingRow {
  readonly id: number;
  readonly fingerprint: string;
  readonly severity: FindingSeverity;
  readonly status: FindingStatus;
  readonly title: string;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly incidentIds: string[];
  readonly runId: string | null;
  readonly currentVerdict: OperatorVerdict | null;
}

export interface AttributionIncidentRow {
  readonly id: string;
  readonly lane: IncidentLane;
  readonly tier: 0 | 1 | 2;
  readonly state: IncidentState;
  readonly signalCount: number;
  readonly firstSignalAt: Date;
  readonly lastSignalAt: Date;
  readonly dispatchedAt: Date | null;
  readonly dispatchOutcome: DispatchOutcome | null;
  readonly latencyMs: number | null;
  readonly decidingRuleId: string | null;
  readonly ruleIds: string[];
  readonly shapeIds: string[];
  readonly signals: JsonValue;
}

export interface AttributionShapeRow {
  readonly entityId: string;
  readonly shapeId: string;
  readonly template: string;
  readonly laneAtTheTime: LogLane;
  readonly lines: number;
  readonly firstBucket: Date;
  readonly lastBucket: Date;
  readonly exemplars: JsonValue;
  readonly routedLane: string | null;
  readonly routedFromLane: string | null;
  readonly laneSource: string | null;
  readonly decidedAt: Date | null;
  readonly ruleId: string | null;
  readonly ruleName: string | null;
  readonly ruleState: string | null;
  readonly ruleOrigin: string | null;
  readonly ruleRationale: string | null;
  readonly proposedByRunId: string | null;
  readonly operatorApproved: boolean | null;
  readonly demotedAt: Date | null;
  readonly demotionDirection: string | null;
  readonly demotionRationale: string | null;
  readonly demotionActor: string | null;
}

export interface MissAttribution {
  readonly verdict: AttributionVerdict;
  readonly findings: AttributionFindingRow[];
  readonly incidents: AttributionIncidentRow[];
  readonly shapes: AttributionShapeRow[];
  readonly entityHadTraffic: boolean;
  readonly computedAt: Date;
  readonly windowFrom: Date;
  readonly windowTo: Date;
}

interface AttributionFindingDbRow {
  id: string | number;
  fingerprint: string;
  severity: FindingSeverity;
  status: FindingStatus;
  title: string;
  first_seen_at: Date;
  last_seen_at: Date;
  incident_ids: string[];
  run_id: string | null;
  current_verdict: OperatorVerdict | null;
}

interface AttributionIncidentDbRow {
  id: string;
  lane: IncidentLane;
  tier: number;
  state: IncidentState;
  signal_count: number;
  first_signal_at: Date;
  last_signal_at: Date;
  dispatched_at: Date | null;
  dispatch_outcome: DispatchOutcome | null;
  latency_ms: number | null;
  deciding_rule_id: string | null;
  rule_ids: string[];
  shape_ids: string[];
  signals: JsonValue;
}

interface AttributionShapeDbRow {
  entity_id: string;
  shape_id: string;
  template: string;
  lane_at_the_time: LogLane;
  lines: string | number;
  first_bucket: Date;
  last_bucket: Date;
  exemplars: JsonValue;
  routed_lane: string | null;
  routed_from_lane: string | null;
  lane_source: string | null;
  decided_at: Date | null;
  rule_id: string | null;
  rule_name: string | null;
  rule_state: string | null;
  rule_origin: string | null;
  rule_rationale: string | null;
  proposed_by_run_id: string | null;
  operator_approved: boolean | null;
  demoted_at: Date | null;
  demotion_direction: string | null;
  demotion_rationale: string | null;
  demotion_actor: string | null;
}

function toAttributionFindingRow(row: AttributionFindingDbRow): AttributionFindingRow {
  return {
    id: Number(row.id),
    fingerprint: row.fingerprint,
    severity: row.severity,
    status: row.status,
    title: row.title,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    incidentIds: row.incident_ids,
    runId: row.run_id,
    currentVerdict: row.current_verdict,
  };
}

function toAttributionIncidentRow(row: AttributionIncidentDbRow): AttributionIncidentRow {
  return {
    id: row.id,
    lane: row.lane,
    tier: row.tier as 0 | 1 | 2,
    state: row.state,
    signalCount: Number(row.signal_count),
    firstSignalAt: row.first_signal_at,
    lastSignalAt: row.last_signal_at,
    dispatchedAt: row.dispatched_at,
    dispatchOutcome: row.dispatch_outcome,
    latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
    decidingRuleId: row.deciding_rule_id,
    ruleIds: row.rule_ids,
    shapeIds: row.shape_ids,
    signals: row.signals,
  };
}

function toAttributionShapeRow(row: AttributionShapeDbRow): AttributionShapeRow {
  return {
    entityId: row.entity_id,
    shapeId: row.shape_id,
    template: row.template,
    laneAtTheTime: row.lane_at_the_time,
    lines: Number(row.lines),
    firstBucket: row.first_bucket,
    lastBucket: row.last_bucket,
    exemplars: row.exemplars,
    routedLane: row.routed_lane,
    routedFromLane: row.routed_from_lane,
    laneSource: row.lane_source,
    decidedAt: row.decided_at,
    ruleId: row.rule_id,
    ruleName: row.rule_name,
    ruleState: row.rule_state,
    ruleOrigin: row.rule_origin,
    ruleRationale: row.rule_rationale,
    proposedByRunId: row.proposed_by_run_id,
    operatorApproved: row.operator_approved,
    demotedAt: row.demoted_at,
    demotionDirection: row.demotion_direction,
    demotionRationale: row.demotion_rationale,
    demotionActor: row.demotion_actor,
  };
}

/**
 * The demotion audit (spec section B.3/B.4): four independent reads (findings, incidents,
 * shapes-with-lane-detail, and a 24h traffic check), then a pure classification. Three round
 * trips carry the CTEs the caller gets back; the shapes of the results are unrelated and
 * joining them in one query would multiply rows. classifyAttribution below never discards:
 * every (window, entity) pair gets an answer, down to "nothing was recorded here".
 */
export async function attributeMiss(pool: Pool, input: MissAttributionInput): Promise<MissAttribution> {
  const entityIds = input.entityIds as string[];

  const findingsResult = await pool.query(
    `SELECT f.id, f.fingerprint, f.severity, f.status, f.title,
            f.first_seen_at, f.last_seen_at, f.incident_ids, f.run_id,
            c.verdict AS current_verdict
     FROM findings f
     LEFT JOIN finding_label_current c ON c.finding_id = f.id
     WHERE f.entity_ids && $3
       AND f.last_seen_at  >= $1::timestamptz - INTERVAL '15 minutes'
       AND f.first_seen_at <= $2::timestamptz + INTERVAL '15 minutes'`,
    [input.windowFrom, input.windowTo, entityIds],
  );
  const findings = (findingsResult.rows as AttributionFindingDbRow[]).map(toAttributionFindingRow);

  const incidentsResult = await pool.query(
    `SELECT i.id, i.lane, i.tier, i.state, i.signal_count,
            i.first_signal_at, i.last_signal_at, i.dispatched_at,
            i.dispatch_outcome, i.latency_ms,
            i.deciding_rule_id, i.rule_ids, i.shape_ids, i.signals
     FROM incidents i
     WHERE i.entity_ids && $3
       AND i.last_signal_at >= $1
       AND i.first_signal_at <= $2`,
    [input.windowFrom, input.windowTo, entityIds],
  );
  const incidents = (incidentsResult.rows as AttributionIncidentDbRow[]).map(toAttributionIncidentRow);

  const shapesResult = await pool.query(
    `WITH shapes_in_window AS (
       SELECT b.entity_id, b.shape_id, s.template,
              b.lane                        AS lane_at_the_time,
              SUM(b.count)::bigint          AS lines,
              MIN(b.bucket_start)           AS first_bucket,
              MAX(b.bucket_start)           AS last_bucket,
              (array_agg(b.exemplars ORDER BY b.bucket_start DESC))[1] AS exemplars
       FROM log_shape_buckets b
       JOIN log_shapes s ON s.entity_id = b.entity_id AND s.shape_id = b.shape_id
       WHERE b.entity_id = ANY($3)
         AND b.bucket_start >= date_trunc('hour', $1::timestamptz)
         AND b.bucket_start <= $2
       GROUP BY b.entity_id, b.shape_id, s.template, b.lane
     ),
     lane_in_force AS (
       SELECT DISTINCT ON (h.entity_id, h.shape_id)
              h.entity_id, h.shape_id, h.to_lane, h.from_lane, h.lane_source, h.at AS decided_at
       FROM log_shape_lane_history h
       WHERE h.entity_id = ANY($3) AND h.at <= $2
       ORDER BY h.entity_id, h.shape_id, h.at DESC
     )
     SELECT
       sw.entity_id, sw.shape_id, sw.template, sw.lane_at_the_time, sw.lines,
       sw.first_bucket, sw.last_bucket, sw.exemplars,
       lf.to_lane          AS routed_lane,
       lf.from_lane        AS routed_from_lane,
       lf.lane_source,
       lf.decided_at,
       r.id                AS rule_id,
       r.name              AS rule_name,
       r.state             AS rule_state,
       r.origin            AS rule_origin,
       r.rationale         AS rule_rationale,
       r.proposed_by_run_id,
       r.operator_approved,
       t.at                AS demoted_at,
       t.direction         AS demotion_direction,
       t.rationale         AS demotion_rationale,
       t.actor             AS demotion_actor
     FROM shapes_in_window sw
     LEFT JOIN lane_in_force lf USING (entity_id, shape_id)
     LEFT JOIN detector_rules r ON r.id = lf.lane_source
     LEFT JOIN LATERAL (
       SELECT d.at, d.direction, d.rationale, d.actor
       FROM detector_rule_transitions d
       WHERE d.rule_id = r.id AND d.direction = 'demotion' AND d.at <= $2
       ORDER BY d.at DESC LIMIT 1
     ) t ON TRUE
     ORDER BY sw.lines DESC
     LIMIT 200`,
    [input.windowFrom, input.windowTo, entityIds],
  );
  const shapes = (shapesResult.rows as AttributionShapeDbRow[]).map(toAttributionShapeRow);

  const trafficResult = await pool.query(
    `SELECT 1 FROM log_shape_buckets
     WHERE entity_id = ANY($3)
       AND bucket_start >= $1::timestamptz - INTERVAL '24 hours'
       AND bucket_start <= $2::timestamptz + INTERVAL '24 hours'
     LIMIT 1`,
    [input.windowFrom, input.windowTo, entityIds],
  );
  const entityHadTraffic = trafficResult.rows.length > 0;

  return {
    verdict: classifyAttribution({ findings, incidents, shapes }),
    findings,
    incidents,
    shapes,
    entityHadTraffic,
    computedAt: new Date(),
    windowFrom: input.windowFrom,
    windowTo: input.windowTo,
  };
}

const LANE_RANK: Readonly<Record<LogLane, number>> = { page: 3, triage: 2, batch: 1, count: 0 };

/**
 * Pure classifier over the three attribution result sets, first match wins (spec section B.4).
 * A page/triage lane observed with no matching incident row is a data gap the table doesn't
 * name; it is folded into batched_only rather than dropped, since "no lane discards" (invariant 3).
 */
export function classifyAttribution(parts: {
  readonly findings: readonly AttributionFindingRow[];
  readonly incidents: readonly AttributionIncidentRow[];
  readonly shapes: readonly AttributionShapeRow[];
}): AttributionVerdict {
  // A finding an operator has since marked 'wrong' was a false positive, not a genuine catch:
  // it must not stand in for real coverage of this window.
  const genuineFindings = parts.findings.filter((f) => f.currentVerdict !== 'wrong');
  if (genuineFindings.length > 0) return 'finding_exists';

  if (parts.incidents.some((i) => i.dispatchOutcome !== null && DROPPED_DISPATCH_OUTCOMES.has(i.dispatchOutcome))) {
    return 'dispatch_dropped';
  }
  if (parts.incidents.some((i) => i.dispatchOutcome !== null && DELIVERED_DISPATCH_OUTCOMES.has(i.dispatchOutcome))) {
    return 'dispatched_no_finding';
  }

  if (parts.shapes.length > 0) {
    const maxLane = parts.shapes.reduce<LogLane>(
      (max, s) => (LANE_RANK[s.laneAtTheTime] > LANE_RANK[max] ? s.laneAtTheTime : max),
      'count',
    );
    return maxLane === 'count' ? 'counted_only' : 'batched_only';
  }

  return 'nothing_recorded';
}

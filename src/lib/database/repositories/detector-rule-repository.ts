import type { Pool } from 'pg';

export type LogLane = 'page' | 'triage' | 'batch' | 'count';
export type Tier = 0 | 1 | 2;
export type RuleKind = 'match' | 'threshold' | 'route' | 'silence' | 'correlate' | 'state';
export type RuleState = 'proposed' | 'shadow' | 'active' | 'rejected' | 'retired';
export type RuleOrigin = 'seed' | 'operator' | 'agent';

export type RuleScope =
  | { readonly kind: 'entity'; readonly entityId: string }
  | { readonly kind: 'service'; readonly serviceKey: string }
  | { readonly kind: 'stack'; readonly project: string }
  | { readonly kind: 'host'; readonly host: string }
  | { readonly kind: 'fleet' };

export interface DetectorRuleProvenance {
  readonly origin: RuleOrigin;
  readonly proposedByRunId: string | null;
  readonly proposedFromFindingId: string | null;
  readonly rationale: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly promotedAt: Date | null;
}

export interface DetectorRuleRecord {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly kind: RuleKind;
  readonly matcher: unknown;
  readonly lane: LogLane;
  readonly state: RuleState;
  readonly enabled: boolean;
  readonly scope: RuleScope;
  readonly appliesToTiers: readonly Tier[] | null;
  readonly priority: number;
  readonly hardSignal: boolean;
  readonly operatorApproved: boolean;
  readonly canaryUntil: Date | null;
  readonly cooldownMs: number | null;
  readonly provenance: DetectorRuleProvenance;
}

export interface UpsertDetectorRuleInput {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly kind: RuleKind;
  readonly matcher: unknown;
  readonly lane: LogLane;
  readonly state: RuleState;
  readonly enabled: boolean;
  readonly scope: RuleScope;
  readonly appliesToTiers: readonly Tier[] | null;
  readonly priority: number;
  readonly hardSignal: boolean;
  readonly operatorApproved: boolean;
  readonly canaryUntil: Date | null;
  readonly cooldownMs: number | null;
  readonly origin: RuleOrigin;
  readonly proposedByRunId: string | null;
  readonly proposedFromFindingId: string | null;
  readonly rationale: string;
}

interface DetectorRuleDbRow {
  id: string;
  version: number;
  name: string;
  kind: RuleKind;
  matcher: unknown;
  lane: LogLane;
  state: RuleState;
  enabled: boolean;
  scope: unknown;
  applies_to_tiers: number[] | null;
  priority: number;
  hard_signal: boolean;
  operator_approved: boolean;
  canary_until: Date | null;
  cooldown_ms: number | null;
  origin: RuleOrigin;
  proposed_by_run_id: string | null;
  proposed_from_finding_id: string | null;
  rationale: string;
  created_at: Date;
  updated_at: Date;
  promoted_at: Date | null;
}

function parseJsonColumn<T>(value: unknown): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : (value as T);
}

function mapRuleRow(row: DetectorRuleDbRow): DetectorRuleRecord {
  return {
    id: row.id,
    version: row.version,
    name: row.name,
    kind: row.kind,
    matcher: parseJsonColumn(row.matcher),
    lane: row.lane,
    state: row.state,
    enabled: row.enabled,
    scope: parseJsonColumn<RuleScope>(row.scope),
    appliesToTiers: row.applies_to_tiers ? (row.applies_to_tiers as Tier[]) : null,
    priority: row.priority,
    hardSignal: row.hard_signal,
    operatorApproved: row.operator_approved,
    canaryUntil: row.canary_until,
    cooldownMs: row.cooldown_ms,
    provenance: {
      origin: row.origin,
      proposedByRunId: row.proposed_by_run_id,
      proposedFromFindingId: row.proposed_from_finding_id,
      rationale: row.rationale,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      promotedAt: row.promoted_at,
    },
  };
}

const RULE_COLUMNS = `id, version, name, kind, matcher, lane, state, enabled, scope, applies_to_tiers,
       priority, hard_signal, operator_approved, canary_until, cooldown_ms,
       origin, proposed_by_run_id, proposed_from_finding_id, rationale,
       created_at, updated_at, promoted_at`;

export class DetectorRuleRepository {
  constructor(private readonly pool: Pool) {}

  async upsertRule(input: UpsertDetectorRuleInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO detector_rules (
         id, version, name, kind, matcher, lane, state, enabled, scope, applies_to_tiers,
         priority, hard_signal, operator_approved, canary_until, cooldown_ms,
         origin, proposed_by_run_id, proposed_from_finding_id, rationale,
         created_at, updated_at, promoted_at
       ) VALUES (
         $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb, $10,
         $11, $12, $13, $14, $15,
         $16, $17, $18, $19,
         NOW(), NOW(), CASE WHEN $7 = 'active' THEN NOW() ELSE NULL END
       )
       ON CONFLICT (id) DO UPDATE SET
         version = EXCLUDED.version,
         name = EXCLUDED.name,
         kind = EXCLUDED.kind,
         matcher = EXCLUDED.matcher,
         lane = EXCLUDED.lane,
         state = EXCLUDED.state,
         enabled = EXCLUDED.enabled,
         scope = EXCLUDED.scope,
         applies_to_tiers = EXCLUDED.applies_to_tiers,
         priority = EXCLUDED.priority,
         hard_signal = EXCLUDED.hard_signal,
         operator_approved = EXCLUDED.operator_approved,
         canary_until = EXCLUDED.canary_until,
         cooldown_ms = EXCLUDED.cooldown_ms,
         origin = EXCLUDED.origin,
         proposed_by_run_id = EXCLUDED.proposed_by_run_id,
         proposed_from_finding_id = EXCLUDED.proposed_from_finding_id,
         rationale = EXCLUDED.rationale,
         updated_at = NOW(),
         promoted_at = COALESCE(
           detector_rules.promoted_at,
           CASE WHEN EXCLUDED.state = 'active' THEN NOW() ELSE NULL END
         )`,
      [
        input.id,
        input.version,
        input.name,
        input.kind,
        JSON.stringify(input.matcher),
        input.lane,
        input.state,
        input.enabled,
        JSON.stringify(input.scope),
        input.appliesToTiers,
        input.priority,
        input.hardSignal,
        input.operatorApproved,
        input.canaryUntil,
        input.cooldownMs,
        input.origin,
        input.proposedByRunId,
        input.proposedFromFindingId,
        input.rationale,
      ],
    );
  }

  async getRule(id: string): Promise<DetectorRuleRecord | null> {
    const result = await this.pool.query(
      `SELECT ${RULE_COLUMNS} FROM detector_rules WHERE id = $1 LIMIT 1`,
      [id],
    );
    const row = result.rows[0] as DetectorRuleDbRow | undefined;
    return row ? mapRuleRow(row) : null;
  }

  /** Rules the engine should evaluate: enabled, and either dispatching (active) or recording only (shadow). */
  async listEvaluableRules(): Promise<DetectorRuleRecord[]> {
    const result = await this.pool.query(
      `SELECT ${RULE_COLUMNS} FROM detector_rules
       WHERE enabled AND state IN ('active', 'shadow')
       ORDER BY id`,
    );
    return (result.rows as DetectorRuleDbRow[]).map(mapRuleRow);
  }

  async listRulesByState(state: RuleState): Promise<DetectorRuleRecord[]> {
    const result = await this.pool.query(
      `SELECT ${RULE_COLUMNS} FROM detector_rules WHERE state = $1 ORDER BY id`,
      [state],
    );
    return (result.rows as DetectorRuleDbRow[]).map(mapRuleRow);
  }

  /** Lifecycle transition (promote/demote/reject/retire). Sets promoted_at the first time state becomes 'active'. Returns false if no rule matched id. */
  async setRuleState(id: string, state: RuleState, at: Date): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE detector_rules SET
         state = $2,
         updated_at = $3,
         promoted_at = COALESCE(promoted_at, CASE WHEN $2 = 'active' THEN $3 ELSE NULL END)
       WHERE id = $1`,
      [id, state, at],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Operator on/off switch, orthogonal to lifecycle state. Returns false if no rule matched id. */
  async setRuleEnabled(id: string, enabled: boolean): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE detector_rules SET enabled = $2, updated_at = NOW() WHERE id = $1`,
      [id, enabled],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

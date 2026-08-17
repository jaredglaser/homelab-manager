import { z } from 'zod';
import type { FindingSeverity, FindingStatus, FindingSubjectKind } from '@/lib/findings/types';

// The one shared module for the feedback layer (spec section G): every other file in
// src/data/feedback, src/lib/mcp/tools/feedback.ts, src/components/findings and the two
// repositories imports its verdict/label/miss shapes from here rather than from each other,
// so a mocked repository module in a test never has to carry these constants too.

// The attribution column stores a JSONB snapshot of a MissAttribution; `unknown` fails the
// server-fn return-type serializability check TanStack Start runs at compile time, so the
// stored shape is typed as JSON rather than left opaque.
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const OPERATOR_VERDICTS = ['actionable', 'noise', 'duplicate', 'wrong'] as const;
export const FEEDBACK_VERDICTS = [...OPERATOR_VERDICTS, 'inconclusive'] as const;
export const LABEL_SOURCES = ['operator', 'implicit', 'agent'] as const;
export const IMPLICIT_SIGNALS = [
  'rollback_after',
  'nonzero_exit_after',
  'restart_after',
  'redeploy_after',
  'quiet_24h',
  'no_outcome_observed',
] as const;
export const CONFOUNDERS = [
  'periodic_restart',
  'host_wide_event',
  'frequent_deploys',
  'sigkill_ambiguous',
  'short_lived_container',
  'multiple_candidate_findings',
  'operator_may_have_acted',
  'slow_burn_candidate',
] as const;

export type OperatorVerdict = (typeof OPERATOR_VERDICTS)[number];
export type FeedbackVerdict = (typeof FEEDBACK_VERDICTS)[number];
export type LabelSource = (typeof LABEL_SOURCES)[number];
export type ImplicitSignal = (typeof IMPLICIT_SIGNALS)[number];
export type Confounder = (typeof CONFOUNDERS)[number];

export const MAX_LABEL_NOTE_CHARS = 1000;

export interface LabelEvidence {
  readonly kind: 'container_event' | 'deploy' | 'absence';
  readonly at: string | null;
  readonly ref: string;
  readonly detail: string;
}

export interface FindingLabel {
  readonly id: number;
  readonly findingId: number;
  readonly verdict: FeedbackVerdict;
  readonly source: LabelSource;
  readonly weight: number;
  readonly signal: ImplicitSignal | null;
  readonly basisAt: Date | null;
  readonly confounders: Confounder[];
  readonly evidence: LabelEvidence[];
  readonly duplicateOfFindingId: number | null;
  readonly note: string;
  readonly labeledBy: string | null;
  readonly labeledAt: Date;
  readonly supersedesLabelId: number | null;
}

export interface FindingVerdictSummary {
  readonly findingId: number;
  readonly verdict: OperatorVerdict;
  readonly source: Exclude<LabelSource, 'implicit'>;
  readonly note: string;
  readonly duplicateOfFindingId: number | null;
  readonly labeledBy: string | null;
  readonly labeledAt: Date;
  readonly relabelCount: number;
}

export interface WeakSignalSummary {
  readonly findingId: number;
  readonly actionableWeight: number;
  readonly noiseWeight: number;
  readonly signalCount: number;
  readonly signals: ImplicitSignal[];
  readonly confounders: Confounder[];
  readonly lastInferredAt: Date;
}

export interface InsertLabelInput {
  readonly findingId: number;
  readonly verdict: FeedbackVerdict;
  readonly source: LabelSource;
  readonly weight: number;
  readonly signal?: ImplicitSignal | null;
  readonly basisAt?: Date | null;
  readonly confounders?: readonly Confounder[];
  readonly evidence?: readonly LabelEvidence[];
  readonly duplicateOfFindingId?: number | null;
  readonly note?: string;
  readonly labeledBy: string | null;
  readonly supersedesLabelId?: number | null;
  readonly at?: Date;
}

export interface ImplicitCandidate {
  readonly findingId: number;
  readonly subjectKind: FindingSubjectKind;
  readonly subjectId: string;
  readonly entityIds: string[];
  readonly host: string;
  readonly stackProject: string | null;
  readonly severity: FindingSeverity;
  readonly status: FindingStatus;
  readonly title: string;
  readonly detail: string;
  readonly lastSeenAt: Date;
  readonly windowFrom: Date | null;
  readonly windowTo: Date | null;
  readonly evaluatedSignals: ImplicitSignal[];
}

export interface ListImplicitCandidatesInput {
  readonly settledBefore: Date;
  readonly notOlderThan: Date;
  readonly quietBefore: Date;
  readonly limit: number;
}

export const MISS_STATUSES = ['new', 'attributed', 'accepted', 'explained', 'invalid'] as const;
export type MissStatus = (typeof MISS_STATUSES)[number];

export const ATTRIBUTION_VERDICTS = [
  'nothing_recorded',
  'counted_only',
  'batched_only',
  'dispatched_no_finding',
  'dispatch_dropped',
  'finding_exists',
] as const;
export type AttributionVerdict = (typeof ATTRIBUTION_VERDICTS)[number];

export const MAX_MISS_DESCRIPTION_CHARS = 4000;
export const MAX_MISS_ENTITY_IDS = 50;

export interface ReportedMiss {
  readonly id: number;
  readonly windowFrom: Date;
  readonly windowTo: Date;
  readonly entityIds: string[];
  readonly host: string | null;
  readonly stackProject: string | null;
  readonly whatHappened: string;
  readonly severity: FindingSeverity;
  readonly status: MissStatus;
  readonly attribution: JsonValue;
  readonly attributionVerdict: AttributionVerdict | null;
  readonly attributedAt: Date | null;
  readonly matchedFindingIds: number[];
  readonly matchedIncidentIds: string[];
  readonly reportedBy: string;
  readonly reportedAt: Date;
  readonly note: string;
  readonly updatedAt: Date;
}

export interface CreateReportedMissInput {
  readonly windowFrom: Date;
  readonly windowTo: Date;
  readonly entityIds: readonly string[];
  readonly host?: string | null;
  readonly stackProject?: string | null;
  readonly whatHappened: string;
  readonly severity: FindingSeverity;
  readonly reportedBy: string;
  readonly note?: string;
}

export interface ListMissesOptions {
  readonly windowFrom?: Date;
  readonly windowTo?: Date;
  readonly entityId?: string;
  readonly status?: MissStatus;
  readonly limit: number;
}

export const zOperatorVerdict = z.enum(OPERATOR_VERDICTS);
export const zLabelNote = z.string().max(MAX_LABEL_NOTE_CHARS);

export interface ReportedMissWire {
  readonly id: number;
  readonly windowFrom: string;
  readonly windowTo: string;
  readonly entityIds: string[];
  readonly host: string | null;
  readonly stackProject: string | null;
  readonly whatHappened: string;
  readonly severity: FindingSeverity;
  readonly status: MissStatus;
  readonly attribution: JsonValue;
  readonly attributionVerdict: AttributionVerdict | null;
  readonly attributedAt: string | null;
  readonly matchedFindingIds: number[];
  readonly matchedIncidentIds: string[];
  readonly reportedBy: string;
  readonly reportedAt: string;
  readonly note: string;
  readonly updatedAt: string;
}

export function toMissWire(miss: ReportedMiss): ReportedMissWire {
  return {
    ...miss,
    windowFrom: miss.windowFrom.toISOString(),
    windowTo: miss.windowTo.toISOString(),
    attributedAt: miss.attributedAt ? miss.attributedAt.toISOString() : null,
    reportedAt: miss.reportedAt.toISOString(),
    updatedAt: miss.updatedAt.toISOString(),
  };
}

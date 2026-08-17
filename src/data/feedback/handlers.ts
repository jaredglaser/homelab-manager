import { MAX_RESOLUTION_CHARS } from '@/lib/findings/types';
import type { FindingStatus, FindingSeverity } from '@/lib/findings/types';
import type { FindingsRepository } from '@/lib/database/repositories/findings-repository';
import type { FindingLabelRepository, InsertLabelInput } from '@/lib/database/repositories/finding-label-repository';
import type { ReportedMissRepository, CreateReportedMissInput } from '@/lib/database/repositories/reported-miss-repository';
import type { MissAttribution, MissAttributionInput } from '@/lib/feedback/attribution';
import type { MetricPeriod } from '@/lib/feedback/metrics';
import type { FeedbackMetrics } from '@/lib/feedback/metrics-service';
import { toMissWire } from '@/lib/feedback/types';
import type {
  OperatorVerdict,
  FindingLabel,
  FindingVerdictSummary,
  WeakSignalSummary,
  ReportedMiss,
  ReportedMissWire,
  MissStatus,
} from '@/lib/feedback/types';

export interface FeedbackHandlerDeps {
  labels: Pick<FindingLabelRepository, 'insert' | 'currentForFindings' | 'weakSignalsForFindings' | 'listForFinding'>;
  findings: Pick<FindingsRepository, 'getById' | 'resolve'>;
  misses: ReportedMissRepository;
  attribute: (input: MissAttributionInput) => Promise<MissAttribution>;
  metrics: (period: MetricPeriod) => Promise<FeedbackMetrics>;
  now: () => Date;
}

export interface LabelFindingInput {
  readonly findingId: number;
  readonly verdict: OperatorVerdict;
  readonly note?: string;
  readonly duplicateOfId?: number;
  readonly close?: boolean;
}

export interface LabelFindingResult {
  readonly findingId: number;
  readonly verdict: OperatorVerdict;
  readonly source: 'operator';
  readonly note: string;
  readonly duplicateOfFindingId: number | null;
  readonly labeledBy: string;
  readonly labeledAt: Date;
  readonly relabelCount: number;
  readonly closed: boolean;
  readonly findingStatus: FindingStatus;
}

export interface ListVerdictsInput {
  readonly findingIds: readonly number[];
}

export interface ListVerdictsResult {
  readonly verdicts: FindingVerdictSummary[];
  readonly weakSignals: WeakSignalSummary[];
}

export interface ReportMissInput {
  readonly windowFrom: Date;
  readonly windowTo: Date;
  readonly entityIds: readonly string[];
  readonly host?: string;
  readonly stackProject?: string;
  readonly whatHappened: string;
  readonly severity: FindingSeverity;
  readonly note?: string;
}

export interface ReportMissResult {
  readonly miss: ReportedMiss;
  readonly attribution: MissAttribution | null;
  readonly attributionFailed: boolean;
}

export interface SetMissStatusInput {
  readonly id: number;
  readonly status: Extract<MissStatus, 'accepted' | 'explained' | 'invalid'>;
  readonly note?: string;
}

export interface MetricsInput {
  readonly from?: Date;
  readonly to?: Date;
}

function pickCurrentLabel(labels: readonly FindingLabel[]): FindingLabel | null {
  const explicit = labels.filter((l) => l.source === 'operator' || l.source === 'agent');
  if (explicit.length === 0) return null;
  return [...explicit].sort((a, b) => {
    if (a.source !== b.source) return a.source === 'operator' ? -1 : 1;
    const byTime = b.labeledAt.getTime() - a.labeledAt.getTime();
    if (byTime !== 0) return byTime;
    return b.id - a.id;
  })[0]!;
}

function resolutionText(verdict: OperatorVerdict, labeledBy: string, note: string, duplicateOfId: number | null): string {
  const base = verdict === 'duplicate' && duplicateOfId !== null ? `Labeled duplicate of #${duplicateOfId} by ${labeledBy}` : `Labeled ${verdict} by ${labeledBy}`;
  const trimmedNote = note.trim();
  const withNote = trimmedNote.length > 0 ? `${base}: ${trimmedNote}` : base;
  return withNote.length > MAX_RESOLUTION_CHARS ? withNote.slice(0, MAX_RESOLUTION_CHARS) : withNote;
}

function isoWeekStart(reference: Date): Date {
  const utcDay = reference.getUTCDay();
  const diffToMonday = (utcDay + 6) % 7;
  return new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate() - diffToMonday));
}

function resolvePeriod(data: MetricsInput, now: Date): MetricPeriod {
  if (data.from !== undefined && data.to !== undefined) return { from: data.from, to: data.to };
  if (data.from !== undefined || data.to !== undefined) {
    throw new Error('Both from and to must be provided together, or neither');
  }
  const from = isoWeekStart(now);
  const to = new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { from, to };
}

export async function handleLabelFinding(deps: FeedbackHandlerDeps, data: LabelFindingInput, actor: string): Promise<LabelFindingResult> {
  const finding = await deps.findings.getById(data.findingId);
  if (!finding) throw new Error(`Finding with id ${data.findingId} not found`);

  const priorLabels = await deps.labels.listForFinding(data.findingId);
  const explicitPriorLabels = priorLabels.filter((l) => l.source === 'operator' || l.source === 'agent');
  const currentLabel = pickCurrentLabel(explicitPriorLabels);
  if (currentLabel && currentLabel.source === 'operator' && currentLabel.verdict === data.verdict) {
    throw new Error(`Finding ${data.findingId} is already labeled '${data.verdict}'; relabeling to the same verdict is a no-op`);
  }

  const note = data.note ?? '';
  const duplicateOfFindingId = data.verdict === 'duplicate' ? (data.duplicateOfId ?? null) : null;
  const at = deps.now();

  const insertInput: InsertLabelInput = {
    findingId: data.findingId,
    verdict: data.verdict,
    source: 'operator',
    weight: 1,
    duplicateOfFindingId,
    note,
    labeledBy: actor,
    supersedesLabelId: currentLabel?.id ?? null,
    at,
  };
  const inserted = await deps.labels.insert(insertInput);

  const shouldClose = data.close ?? data.verdict !== 'actionable';
  let closed = false;
  let findingStatus: FindingStatus = finding.status;

  if (shouldClose) {
    const resolution = resolutionText(data.verdict, actor, note, duplicateOfFindingId);
    const result = await deps.findings.resolve({ id: data.findingId, status: 'dismissed', resolution, at: inserted.labeledAt });
    if (result) {
      findingStatus = result.finding.status;
      closed = !result.alreadyClosed;
    }
  }

  return {
    findingId: data.findingId,
    verdict: data.verdict,
    source: 'operator',
    note,
    duplicateOfFindingId,
    labeledBy: actor,
    labeledAt: inserted.labeledAt,
    relabelCount: explicitPriorLabels.length,
    closed,
    findingStatus,
  };
}

export async function handleListFindingVerdicts(deps: FeedbackHandlerDeps, data: ListVerdictsInput): Promise<ListVerdictsResult> {
  if (data.findingIds.length === 0) return { verdicts: [], weakSignals: [] };

  const [verdictsMap, weakMap] = await Promise.all([deps.labels.currentForFindings(data.findingIds), deps.labels.weakSignalsForFindings(data.findingIds)]);

  return { verdicts: [...verdictsMap.values()], weakSignals: [...weakMap.values()] };
}

export async function handleReportMiss(deps: FeedbackHandlerDeps, data: ReportMissInput, actor: string): Promise<ReportMissResult> {
  const createInput: CreateReportedMissInput = {
    windowFrom: data.windowFrom,
    windowTo: data.windowTo,
    entityIds: [...data.entityIds],
    host: data.host ?? null,
    stackProject: data.stackProject ?? null,
    whatHappened: data.whatHappened,
    severity: data.severity,
    reportedBy: actor,
    note: data.note ?? '',
  };

  const miss = await deps.misses.create(createInput);

  try {
    const attribution = await deps.attribute({ windowFrom: data.windowFrom, windowTo: data.windowTo, entityIds: data.entityIds });
    const findingIds = attribution.findings.map((f: { id: number }) => f.id);
    const incidentIds = attribution.incidents.map((i: { id: string }) => i.id);
    const saved = await deps.misses.saveAttribution(miss.id, attribution.verdict, attribution, findingIds, incidentIds, deps.now());
    return { miss: saved ?? miss, attribution, attributionFailed: false };
  } catch (err) {
    console.error(`[feedback] Miss attribution failed for reported miss ${miss.id}:`, err instanceof Error ? err.message : err);
    return { miss, attribution: null, attributionFailed: true };
  }
}

export async function handleSetMissStatus(deps: FeedbackHandlerDeps, data: SetMissStatusInput): Promise<ReportedMissWire> {
  const updated = await deps.misses.setStatus(data.id, data.status, data.note ?? '');
  if (!updated) throw new Error(`Reported miss with id ${data.id} not found`);
  return toMissWire(updated);
}

export async function handleReattributeMiss(deps: FeedbackHandlerDeps, data: { id: number }): Promise<ReportMissResult> {
  const existing = await deps.misses.getById(data.id);
  if (!existing) throw new Error(`Reported miss with id ${data.id} not found`);

  try {
    const attribution = await deps.attribute({ windowFrom: existing.windowFrom, windowTo: existing.windowTo, entityIds: existing.entityIds });
    const findingIds = attribution.findings.map((f: { id: number }) => f.id);
    const incidentIds = attribution.incidents.map((i: { id: string }) => i.id);
    const saved = await deps.misses.saveAttribution(existing.id, attribution.verdict, attribution, findingIds, incidentIds, deps.now());
    return { miss: saved ?? existing, attribution, attributionFailed: false };
  } catch (err) {
    console.error(`[feedback] Re-attribution failed for reported miss ${existing.id}:`, err instanceof Error ? err.message : err);
    return { miss: existing, attribution: null, attributionFailed: true };
  }
}

export async function handleGetFeedbackMetrics(deps: FeedbackHandlerDeps, data: MetricsInput): Promise<FeedbackMetrics> {
  const period = resolvePeriod(data, deps.now());
  return deps.metrics(period);
}

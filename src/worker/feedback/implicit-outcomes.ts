import type {
  Confounder,
  FeedbackVerdict,
  ImplicitCandidate,
  ImplicitSignal,
  LabelEvidence,
} from '@/lib/database/repositories/finding-label-repository';

export interface ImplicitOutcomeConfig {
  readonly actionWindowMs: number;
  readonly deployWindowMs: number;
  readonly quietWindowMs: number;
  readonly periodicRestartMinCount: number;
  readonly periodicRestartMaxCv: number;
  readonly frequentDeployMinCount: number;
  readonly shortLivedMedianMs: number;
  readonly hostWideMinContainers: number;
  readonly hostWideWindowMs: number;
}

export const DEFAULT_IMPLICIT_CONFIG: ImplicitOutcomeConfig = {
  actionWindowMs: 10 * 60 * 1000,
  deployWindowMs: 60 * 60 * 1000,
  quietWindowMs: 24 * 60 * 60 * 1000,
  periodicRestartMinCount: 3,
  periodicRestartMaxCv: 0.25,
  frequentDeployMinCount: 5,
  shortLivedMedianMs: 5 * 60 * 1000,
  hostWideMinContainers: 3,
  hostWideWindowMs: 5 * 60 * 1000,
};

const SETTLE_SLACK_MS = 5 * 60 * 1000;

const BASE_WEIGHT: Readonly<Partial<Record<ImplicitSignal, number>>> = {
  rollback_after: 0.4,
  nonzero_exit_after: 0.35,
  restart_after: 0.25,
  redeploy_after: 0.2,
  quiet_24h: 0.15,
};

const DAMPENED_WEIGHT: Readonly<Partial<Record<ImplicitSignal, number>>> = {
  rollback_after: 0.1,
  nonzero_exit_after: 0.1,
  restart_after: 0.05,
  redeploy_after: 0.05,
};

const NO_OUTCOME_WEIGHT = 0.05;

const CLEAN_EXIT_CODES = new Set([0, 130, 143]);

const SLOW_BURN_PATTERN = /\b(disk|memory|mem|certificate|cert|quota|leak|expir(?:e|es|ing|y))\b/i;

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function loadImplicitOutcomeConfig(env: NodeJS.ProcessEnv = process.env): ImplicitOutcomeConfig {
  return {
    ...DEFAULT_IMPLICIT_CONFIG,
    actionWindowMs: parsePositiveIntEnv(env.FEEDBACK_ACTION_WINDOW_MS, DEFAULT_IMPLICIT_CONFIG.actionWindowMs),
    deployWindowMs: parsePositiveIntEnv(env.FEEDBACK_DEPLOY_WINDOW_MS, DEFAULT_IMPLICIT_CONFIG.deployWindowMs),
    quietWindowMs: parsePositiveIntEnv(env.FEEDBACK_QUIET_WINDOW_MS, DEFAULT_IMPLICIT_CONFIG.quietWindowMs),
  };
}

export interface ContainerEventFact {
  readonly at: number;
  readonly state: string | null;
  readonly eventType: 'upsert' | 'destroy';
  readonly exitCode: number | null;
  readonly startedAt: number | null;
  readonly containerId: string;
  readonly host: string;
}

export interface DeployFact {
  readonly id: number;
  readonly at: number;
  readonly action: string;
  readonly status: string;
  readonly trigger: string;
  readonly stack: string;
  readonly host: string;
}

export interface EntityTimeline {
  readonly entityId: string;
  readonly events: readonly ContainerEventFact[];
  readonly deploys: readonly DeployFact[];
  readonly restartTimestamps7d: readonly number[];
  readonly deployCount7d: number;
  readonly medianLifetimeMs: number | null;
  readonly hostRestartTimestamps7d: readonly number[];
  readonly openFindingIdsOnEntity: readonly number[];
}

export interface InferredLabel {
  readonly findingId: number;
  readonly verdict: FeedbackVerdict;
  readonly signal: ImplicitSignal;
  readonly weight: number;
  readonly confounders: Confounder[];
  readonly evidence: LabelEvidence[];
  readonly basisAt: Date;
}

export function coefficientOfVariation(intervals: readonly number[]): number {
  if (intervals.length === 0) return 0;
  const mean = intervals.reduce((sum, v) => sum + v, 0) / intervals.length;
  if (mean === 0) return 0;
  const variance = intervals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / intervals.length;
  return Math.sqrt(variance) / mean;
}

export function detectPeriodicRestart(timestamps: readonly number[], config: ImplicitOutcomeConfig): boolean {
  if (timestamps.length < config.periodicRestartMinCount) return false;
  const sorted = [...timestamps].sort((a, b) => a - b);
  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i++) intervals.push(sorted[i] - sorted[i - 1]);
  if (intervals.length === 0) return false;
  return coefficientOfVariation(intervals) < config.periodicRestartMaxCv;
}

function isHostWideEvent(eventAt: number, hostRestartTimestamps7d: readonly number[], config: ImplicitOutcomeConfig): boolean {
  const nearby = hostRestartTimestamps7d.filter((t) => Math.abs(t - eventAt) <= config.hostWideWindowMs);
  return nearby.length >= config.hostWideMinContainers;
}

function isSettled(lastSeenAt: Date, windowMs: number, now: Date): boolean {
  return now.getTime() >= lastSeenAt.getTime() + windowMs + SETTLE_SLACK_MS;
}

function inWindow(at: number, lastSeenMs: number, windowMs: number, windowFrom: Date | null, windowTo: Date | null): boolean {
  if (at <= lastSeenMs) return false;
  if (at > lastSeenMs + windowMs) return false;
  if (windowFrom !== null && windowTo !== null && at >= windowFrom.getTime() && at <= windowTo.getTime()) return false;
  return true;
}

function startedAtInForce(events: readonly ContainerEventFact[], atOrBefore: number): number | null {
  let latest: ContainerEventFact | null = null;
  for (const event of events) {
    if (event.at <= atOrBefore && (latest === null || event.at > latest.at)) latest = event;
  }
  if (latest === null || latest.state !== 'running') return null;
  return latest.startedAt;
}

function findRestartEvent(
  timeline: EntityTimeline,
  candidate: ImplicitCandidate,
  config: ImplicitOutcomeConfig,
  lastSeenMs: number,
): ContainerEventFact | undefined {
  const baseline = startedAtInForce(timeline.events, lastSeenMs);
  return timeline.events.find(
    (event) =>
      event.state === 'running' &&
      event.startedAt !== null &&
      inWindow(event.at, lastSeenMs, config.actionWindowMs, candidate.windowFrom, candidate.windowTo) &&
      (baseline === null || event.startedAt > baseline),
  );
}

function findNonzeroExitEvent(
  timeline: EntityTimeline,
  candidate: ImplicitCandidate,
  config: ImplicitOutcomeConfig,
  lastSeenMs: number,
): ContainerEventFact | undefined {
  return timeline.events.find(
    (event) =>
      event.state === 'exited' &&
      event.exitCode !== null &&
      !CLEAN_EXIT_CODES.has(event.exitCode) &&
      inWindow(event.at, lastSeenMs, config.actionWindowMs, candidate.windowFrom, candidate.windowTo),
  );
}

function findRollbackDeploy(
  timeline: EntityTimeline,
  candidate: ImplicitCandidate,
  config: ImplicitOutcomeConfig,
  lastSeenMs: number,
): DeployFact | undefined {
  if (candidate.stackProject === null) return undefined;
  return timeline.deploys.find(
    (deploy) =>
      deploy.stack === candidate.stackProject &&
      deploy.host === candidate.host &&
      deploy.trigger === 'manual_rollback' &&
      inWindow(deploy.at, lastSeenMs, config.deployWindowMs, candidate.windowFrom, candidate.windowTo),
  );
}

function findRedeployDeploy(
  timeline: EntityTimeline,
  candidate: ImplicitCandidate,
  config: ImplicitOutcomeConfig,
  lastSeenMs: number,
): DeployFact | undefined {
  if (candidate.stackProject === null) return undefined;
  return timeline.deploys.find(
    (deploy) =>
      deploy.stack === candidate.stackProject &&
      deploy.host === candidate.host &&
      (deploy.action === 'deploy' || deploy.action === 'update') &&
      deploy.status === 'succeeded' &&
      inWindow(deploy.at, lastSeenMs, config.deployWindowMs, candidate.windowFrom, candidate.windowTo),
  );
}

function hasQuietDisqualifyingActivity(
  timeline: EntityTimeline,
  candidate: ImplicitCandidate,
  lastSeenMs: number,
  quietWindowMs: number,
): boolean {
  const to = lastSeenMs + quietWindowMs;
  const eventActivity = timeline.events.some((event) => {
    if (!inWindow(event.at, lastSeenMs, quietWindowMs, candidate.windowFrom, candidate.windowTo)) return false;
    if (event.eventType === 'destroy') return true;
    return event.state !== 'running' || event.exitCode !== null;
  });
  if (eventActivity) return true;
  return timeline.deploys.some((deploy) => deploy.at > lastSeenMs && deploy.at <= to);
}

function isSlowBurnCandidate(candidate: ImplicitCandidate): boolean {
  return SLOW_BURN_PATTERN.test(`${candidate.title} ${candidate.detail}`);
}

function eventEvidence(host: string, event: ContainerEventFact, detail: string): LabelEvidence {
  const at = new Date(event.at).toISOString();
  return { kind: 'container_event', at, ref: `${host}/${event.containerId}@${at}`, detail };
}

function deployEvidence(deploy: DeployFact, detail: string): LabelEvidence {
  return { kind: 'deploy', at: new Date(deploy.at).toISOString(), ref: String(deploy.id), detail };
}

function absenceEvidence(detail: string): LabelEvidence {
  return { kind: 'absence', at: null, ref: '', detail };
}

function weightFor(signal: ImplicitSignal, confounders: readonly Confounder[]): number {
  if (confounders.length === 0) return BASE_WEIGHT[signal] ?? NO_OUTCOME_WEIGHT;
  return DAMPENED_WEIGHT[signal] ?? BASE_WEIGHT[signal] ?? NO_OUTCOME_WEIGHT;
}

export function inferImplicitLabels(
  candidate: ImplicitCandidate,
  timeline: EntityTimeline,
  config: ImplicitOutcomeConfig,
  now: Date,
): InferredLabel[] {
  const results: InferredLabel[] = [];
  const lastSeenMs = candidate.lastSeenAt.getTime();
  const already = new Set<ImplicitSignal>(candidate.evaluatedSignals);
  const hasOtherOpenFindings = timeline.openFindingIdsOnEntity.some((id) => id !== candidate.findingId);

  // Computed once, independent of whether redeploy_after's own (longer) settle window has
  // elapsed this tick: the deploy row is either already in the loaded timeline or it is not,
  // regardless of settle status. Checking only redeployFired (this call's own outcome) missed
  // the case where the action window settles on an earlier tick than the deploy window - the
  // redeploy row would already exist by then, but redeploy_after itself would not run until a
  // later tick, letting restart_after fire first and both signals land for the same event.
  const redeployMatch = findRedeployDeploy(timeline, candidate, config, lastSeenMs);

  if (!already.has('redeploy_after') && isSettled(candidate.lastSeenAt, config.deployWindowMs, now)) {
    if (redeployMatch) {
      const confounders: Confounder[] = [];
      if (timeline.deployCount7d >= config.frequentDeployMinCount) confounders.push('frequent_deploys');
      if (hasOtherOpenFindings) confounders.push('multiple_candidate_findings');
      results.push({
        findingId: candidate.findingId,
        verdict: 'actionable',
        signal: 'redeploy_after',
        weight: weightFor('redeploy_after', confounders),
        confounders,
        evidence: [deployEvidence(redeployMatch, `${redeployMatch.action} succeeded on ${redeployMatch.stack}/${redeployMatch.host}`)],
        basisAt: candidate.lastSeenAt,
      });
    }
  }

  // A container recreated by a deploy also emits a `running` row with a new started_at;
  // when a matching redeploy exists, restart_after is suppressed rather than double-counted,
  // whether or not redeploy_after itself fired on this tick.
  if (!already.has('restart_after') && !redeployMatch && isSettled(candidate.lastSeenAt, config.actionWindowMs, now)) {
    const match = findRestartEvent(timeline, candidate, config, lastSeenMs);
    if (match) {
      const dampeningConfounders: Confounder[] = [];
      if (detectPeriodicRestart(timeline.restartTimestamps7d, config)) dampeningConfounders.push('periodic_restart');
      if (isHostWideEvent(match.at, timeline.hostRestartTimestamps7d, config)) dampeningConfounders.push('host_wide_event');
      if (hasOtherOpenFindings) dampeningConfounders.push('multiple_candidate_findings');
      // operator_may_have_acted is attached unconditionally on every restart_after firing (we
      // cannot tell whether the operator read the finding first) and, unlike the other
      // confounders, never dampens the weight on its own - otherwise the base weight would
      // never apply.
      const confounders: Confounder[] = ['operator_may_have_acted', ...dampeningConfounders];
      results.push({
        findingId: candidate.findingId,
        verdict: 'actionable',
        signal: 'restart_after',
        weight: weightFor('restart_after', dampeningConfounders),
        confounders,
        evidence: [eventEvidence(match.host, match, 'container restarted')],
        basisAt: candidate.lastSeenAt,
      });
    }
  }

  if (!already.has('nonzero_exit_after') && isSettled(candidate.lastSeenAt, config.actionWindowMs, now)) {
    const match = findNonzeroExitEvent(timeline, candidate, config, lastSeenMs);
    if (match && match.exitCode !== null) {
      const confounders: Confounder[] = [];
      if (match.exitCode === 137) confounders.push('sigkill_ambiguous');
      if (timeline.medianLifetimeMs !== null && timeline.medianLifetimeMs < config.shortLivedMedianMs) {
        confounders.push('short_lived_container');
      }
      if (hasOtherOpenFindings) confounders.push('multiple_candidate_findings');
      results.push({
        findingId: candidate.findingId,
        verdict: 'actionable',
        signal: 'nonzero_exit_after',
        weight: weightFor('nonzero_exit_after', confounders),
        confounders,
        evidence: [eventEvidence(match.host, match, `exited with code ${match.exitCode}`)],
        basisAt: candidate.lastSeenAt,
      });
    }
  }

  if (!already.has('rollback_after') && isSettled(candidate.lastSeenAt, config.deployWindowMs, now)) {
    const match = findRollbackDeploy(timeline, candidate, config, lastSeenMs);
    if (match) {
      const confounders: Confounder[] = [];
      if (hasOtherOpenFindings) confounders.push('multiple_candidate_findings');
      results.push({
        findingId: candidate.findingId,
        verdict: 'actionable',
        signal: 'rollback_after',
        weight: weightFor('rollback_after', confounders),
        confounders,
        evidence: [deployEvidence(match, `manual rollback on ${match.stack}/${match.host}`)],
        basisAt: candidate.lastSeenAt,
      });
    }
  }

  if (
    !already.has('quiet_24h') &&
    candidate.status === 'open' &&
    candidate.severity !== 'critical' &&
    isSettled(candidate.lastSeenAt, config.quietWindowMs, now) &&
    !hasQuietDisqualifyingActivity(timeline, candidate, lastSeenMs, config.quietWindowMs)
  ) {
    const confounders: Confounder[] = [];
    if (isSlowBurnCandidate(candidate)) confounders.push('slow_burn_candidate');
    results.push({
      findingId: candidate.findingId,
      verdict: 'noise',
      signal: 'quiet_24h',
      weight: BASE_WEIGHT.quiet_24h ?? NO_OUTCOME_WEIGHT,
      confounders,
      evidence: [absenceEvidence('no restart, exit, deploy or destroy observed in the 24h following last_seen_at')],
      basisAt: candidate.lastSeenAt,
    });
  }

  const longestPositiveWindow = Math.max(config.actionWindowMs, config.deployWindowMs);
  if (
    !already.has('no_outcome_observed') &&
    already.size === 0 &&
    results.length === 0 &&
    isSettled(candidate.lastSeenAt, longestPositiveWindow, now)
  ) {
    results.push({
      findingId: candidate.findingId,
      verdict: 'inconclusive',
      signal: 'no_outcome_observed',
      weight: NO_OUTCOME_WEIGHT,
      confounders: [],
      evidence: [absenceEvidence('no restart, exit, deploy or rollback observed in the evaluation window')],
      basisAt: candidate.lastSeenAt,
    });
  }

  return results;
}

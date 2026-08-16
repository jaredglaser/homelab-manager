import { LANE_SEVERITY, type LogLane, type LogStream, type Tier } from '@/lib/logs/types';
import type { NormalizedShape } from '@/lib/logs/shape';
import type { RateVerdict, SilenceVerdict } from '@/lib/logs/baseline';

export const MAX_LINE_MATCH_CHARS = 2048;
export const MAX_PATTERN_CHARS = 200;
export const MAX_SHADOW_COUNTERFACTUALS = 8;
export const MAX_SUPPRESSED_RECORDED = 16;
export const ALLOWED_REGEX_FLAGS = 'imus';

export type RuleKind = 'match' | 'threshold' | 'route' | 'silence' | 'correlate' | 'state';
export type RuleState = 'proposed' | 'shadow' | 'active' | 'rejected' | 'retired';
export type RuleOrigin = 'seed' | 'operator' | 'agent';

export type RuleScope =
  | { readonly kind: 'entity'; readonly entityId: string }
  | { readonly kind: 'service'; readonly serviceKey: string }
  | { readonly kind: 'stack'; readonly project: string }
  | { readonly kind: 'host'; readonly host: string }
  | { readonly kind: 'fleet' };

export type ThresholdMetric = 'lineCount' | 'stderrCount' | 'stderrRatio' | 'shapeCount';
export type ThresholdComparison = 'absolute' | 'baselineMultiple' | 'zScore';

export type RuleMatcher =
  | {
      readonly type: 'literal';
      readonly needle: string;
      readonly caseSensitive: boolean;
      readonly target: 'raw' | 'template';
      readonly stream: LogStream | 'any';
    }
  | {
      readonly type: 'regex';
      readonly pattern: string;
      readonly flags: string;
      readonly target: 'raw' | 'template';
      readonly stream: LogStream | 'any';
    }
  | { readonly type: 'shape'; readonly shapeIds: readonly string[] }
  | {
      readonly type: 'threshold';
      readonly metric: ThresholdMetric;
      readonly comparison: ThresholdComparison;
      readonly value: number;
      readonly windowMs: number;
      readonly shapeId?: string;
      readonly sinceImageChangeMaxMs?: number;
    }
  | { readonly type: 'silence'; readonly windowMs: number }
  | {
      readonly type: 'event';
      readonly eventTypes: readonly string[];
      readonly oomKilled?: boolean;
      readonly exitCodeNonZero?: boolean;
      readonly healthStatus?: 'unhealthy' | 'starting';
      readonly minRestartsInWindow?: number;
      readonly windowMs?: number;
    }
  | { readonly type: 'correlate'; readonly ruleIds: readonly string[]; readonly windowMs: number };

export interface RuleProvenance {
  readonly origin: RuleOrigin;
  readonly proposedByRunId: string | null;
  readonly proposedFromFindingId: string | null;
  readonly rationale: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly promotedAt: Date | null;
}

export interface DetectorRule {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly kind: RuleKind;
  readonly matcher: RuleMatcher;
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
  readonly provenance: RuleProvenance;
}

export interface ContainerStateEvent {
  readonly eventType: string;
  readonly state: string | null;
  readonly exitCode: number | null;
  readonly oomKilled: boolean;
  readonly healthStatus: string | null;
  readonly restartsInWindow: number;
  readonly windowMs: number;
}

export interface WindowMetrics {
  readonly windowMs: number;
  readonly lineCount: number;
  readonly stderrCount: number;
  readonly stderrRatio: number;
  readonly shapeCounts: ReadonlyMap<string, number>;
  readonly lastNonEmptyAgoMs: number;
  readonly verdicts: {
    readonly lines: RateVerdict | null;
    readonly stderr: RateVerdict | null;
    readonly stderrRatio: RateVerdict | null;
  };
  readonly silence: SilenceVerdict | null;
}

interface BaseEvalContext {
  readonly at: number;
  readonly entityId: string;
  readonly host: string;
  readonly serviceKey: string | null;
  readonly stackProject: string | null;
  readonly tier: Tier;
  readonly coldStart: boolean;
  readonly sinceImageChangeMs: number | null;
  readonly recentRuleMatches: ReadonlyMap<string, readonly number[]>;
}

export interface LineEvalContext extends BaseEvalContext {
  readonly trigger: 'line';
  readonly line: string;
  readonly stream: LogStream;
  readonly shape: NormalizedShape;
}

export interface TickEvalContext extends BaseEvalContext {
  readonly trigger: 'tick';
  readonly metrics: WindowMetrics;
}

export interface EventEvalContext extends BaseEvalContext {
  readonly trigger: 'event';
  readonly event: ContainerStateEvent;
}

export type RuleEvalContext = LineEvalContext | TickEvalContext | EventEvalContext;

export interface RuleMatchEvidence {
  readonly matchedText: string | null;
  readonly metric: string | null;
  readonly observed: number | null;
  readonly expected: number | null;
  readonly z: number | null;
}

export interface RuleMatch {
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly kind: RuleKind;
  readonly lane: LogLane;
  readonly scopeSpecificity: number;
  readonly priority: number;
  readonly updatedAt: number;
  readonly hardSignal: boolean;
  readonly isCanary: boolean;
  readonly evidence: RuleMatchEvidence;
}

export interface ShadowRuleMatch extends RuleMatch {
  readonly wouldBeLane: LogLane;
  readonly wouldChangeLane: boolean;
  readonly wouldBeClamped: boolean;
}

export interface SuppressedRule {
  readonly ruleId: string;
  readonly reason: 'cold-start' | 'baseline-cold' | 'tier-excluded' | 'scope-excluded' | 'trigger-mismatch';
}

export interface LaneDecision {
  readonly lane: LogLane;
  readonly source: 'rule' | 'default';
  readonly decidingRuleId: string | null;
  readonly preClampLane: LogLane;
  readonly clamped: boolean;
  readonly clampReasons: readonly string[];
  readonly matches: readonly RuleMatch[];
  readonly shadow: readonly ShadowRuleMatch[];
  readonly suppressed: readonly SuppressedRule[];
  readonly truncatedShadow: boolean;
  readonly shapeId: string | null;
}

export interface CompiledRule {
  readonly rule: DetectorRule;
  readonly regex: RegExp | null;
  readonly shapeIds: ReadonlySet<string> | null;
}

export interface CompiledRuleSet {
  readonly rules: readonly CompiledRule[];
  readonly byTrigger: Readonly<Record<'line' | 'tick' | 'event', readonly CompiledRule[]>>;
  readonly invalid: readonly { readonly ruleId: string; readonly error: string }[];
}

const KIND_MATCHER_TYPES: Readonly<Record<RuleKind, readonly RuleMatcher['type'][]>> = {
  match: ['literal', 'regex', 'shape'],
  threshold: ['threshold'],
  route: ['shape'],
  silence: ['silence'],
  correlate: ['correlate'],
  state: ['event'],
};

const BACKREFERENCE_RE = /\\[1-9]|\\k<[^>]*>/;

/**
 * Syntactic policy only. Catastrophic backtracking is decided by
 * `@/lib/logs/pattern-safety`, which is authoritative and runs at rule admission;
 * every check here is sound alone and rejects no legitimate pattern.
 */
export function checkPatternPolicy(pattern: string): { readonly ok: boolean; readonly reason: string | null } {
  if (pattern.length > MAX_PATTERN_CHARS) {
    return { ok: false, reason: 'pattern-too-long' };
  }
  if (BACKREFERENCE_RE.test(pattern)) {
    return { ok: false, reason: 'backreference' };
  }
  const quantifiers = pattern.match(/\{(\d+)(?:,(\d*))?\}/g) ?? [];
  for (const quantifier of quantifiers) {
    const parsed = /\{(\d+)(?:,(\d*))?\}/.exec(quantifier);
    if (!parsed) continue;
    const min = Number(parsed[1]);
    const hasComma = parsed[2] !== undefined;
    if (hasComma && parsed[2] === '') {
      continue;
    }
    const max = hasComma ? Number(parsed[2]) : min;
    if (max > 1000) {
      return { ok: false, reason: 'unbounded-repeat' };
    }
  }
  try {
    new RegExp(pattern);
  } catch {
    return { ok: false, reason: 'invalid-regex' };
  }
  return { ok: true, reason: null };
}

export function assertPatternPolicy(pattern: string): void {
  const result = checkPatternPolicy(pattern);
  if (!result.ok) {
    throw new Error(`rejected regex pattern: ${result.reason}`);
  }
}

function filterRegexFlags(flags: string): string {
  let result = '';
  for (const char of flags) {
    if (ALLOWED_REGEX_FLAGS.includes(char) && !result.includes(char)) {
      result += char;
    }
  }
  return result;
}

export function compileRule(rule: DetectorRule): CompiledRule {
  const allowed = KIND_MATCHER_TYPES[rule.kind];
  if (!allowed.includes(rule.matcher.type)) {
    throw new Error(`rule ${rule.id}: kind '${rule.kind}' cannot use matcher type '${rule.matcher.type}'`);
  }
  if (rule.matcher.type === 'regex') {
    assertPatternPolicy(rule.matcher.pattern);
    const flags = filterRegexFlags(rule.matcher.flags);
    let regex: RegExp;
    try {
      regex = new RegExp(rule.matcher.pattern, flags);
    } catch (err) {
      throw new Error(`rule ${rule.id}: invalid regex: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { rule, regex, shapeIds: null };
  }
  if (rule.matcher.type === 'shape') {
    return { rule, regex: null, shapeIds: new Set(rule.matcher.shapeIds) };
  }
  return { rule, regex: null, shapeIds: null };
}

export function compileRules(rules: readonly DetectorRule[]): CompiledRuleSet {
  const compiled: CompiledRule[] = [];
  const invalid: { readonly ruleId: string; readonly error: string }[] = [];
  for (const rule of rules) {
    try {
      compiled.push(compileRule(rule));
    } catch (err) {
      invalid.push({ ruleId: rule.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const line: CompiledRule[] = [];
  const tick: CompiledRule[] = [];
  const event: CompiledRule[] = [];
  for (const c of compiled) {
    const bucket = matcherTrigger(c.rule.matcher.type);
    if (bucket === 'line') line.push(c);
    else if (bucket === 'tick') tick.push(c);
    else event.push(c);
  }
  return { rules: compiled, byTrigger: { line, tick, event }, invalid };
}

function matcherTrigger(type: RuleMatcher['type']): 'line' | 'tick' | 'event' {
  switch (type) {
    case 'literal':
    case 'regex':
    case 'shape':
    case 'correlate':
      return 'line';
    case 'threshold':
    case 'silence':
      return 'tick';
    case 'event':
      return 'event';
  }
}

export function scopeSpecificity(scope: RuleScope): number {
  switch (scope.kind) {
    case 'entity':
      return 5;
    case 'service':
      return 4;
    case 'stack':
      return 3;
    case 'host':
      return 2;
    case 'fleet':
      return 1;
  }
}

function scopeMatchesContext(scope: RuleScope, ctx: RuleEvalContext): boolean {
  switch (scope.kind) {
    case 'entity':
      return scope.entityId === ctx.entityId;
    case 'service':
      return ctx.serviceKey !== null && scope.serviceKey === ctx.serviceKey;
    case 'stack':
      return ctx.stackProject !== null && scope.project === ctx.stackProject;
    case 'host':
      return scope.host === ctx.host;
    case 'fleet':
      return true;
  }
}

export function ruleAppliesTo(rule: DetectorRule, ctx: RuleEvalContext): boolean {
  if (rule.appliesToTiers !== null && !rule.appliesToTiers.includes(ctx.tier)) {
    return false;
  }
  return scopeMatchesContext(rule.scope, ctx);
}

export function defaultLaneForTier(tier: Tier, coldStart: boolean): LogLane {
  if (tier === 0) {
    return coldStart ? 'batch' : 'triage';
  }
  return 'batch';
}

export function compareRuleMatches(a: RuleMatch, b: RuleMatch): number {
  if (a.scopeSpecificity !== b.scopeSpecificity) {
    return b.scopeSpecificity - a.scopeSpecificity;
  }
  if (a.priority !== b.priority) {
    return b.priority - a.priority;
  }
  const laneDiff = LANE_SEVERITY[b.lane] - LANE_SEVERITY[a.lane];
  if (laneDiff !== 0) {
    return laneDiff;
  }
  const updatedDiff = b.updatedAt - a.updatedAt;
  if (Number.isFinite(updatedDiff) && updatedDiff !== 0) {
    return updatedDiff;
  }
  if (a.ruleId < b.ruleId) return -1;
  if (a.ruleId > b.ruleId) return 1;
  return 0;
}

export function clampLane(
  lane: LogLane,
  ctx: RuleEvalContext,
  decidingRule: DetectorRule | null,
  matches: readonly RuleMatch[],
): { readonly lane: LogLane; readonly clamped: boolean; readonly reasons: readonly string[] } {
  let current = lane;
  const reasons: string[] = [];

  if (current === 'page' && ctx.tier !== 0) {
    current = 'triage';
    reasons.push('page-requires-tier0');
  }

  const hasHardSignalMatch = matches.some((m) => m.hardSignal);
  if (hasHardSignalMatch && LANE_SEVERITY[current] < LANE_SEVERITY.triage && !decidingRule?.operatorApproved) {
    current = 'triage';
    reasons.push('hard-signal-floor');
  }

  if (
    ctx.tier === 0 &&
    !ctx.coldStart &&
    LANE_SEVERITY[current] < LANE_SEVERITY.triage &&
    !decidingRule?.operatorApproved
  ) {
    current = 'triage';
    reasons.push('tier0-demotion-requires-approval');
  }

  if (decidingRule !== null && decidingRule.scope.kind === 'fleet' && !decidingRule.operatorApproved) {
    const floor = defaultLaneForTier(ctx.tier, ctx.coldStart);
    if (LANE_SEVERITY[current] < LANE_SEVERITY[floor]) {
      current = floor;
      reasons.push('fleet-demotion-requires-approval');
    }
  }

  return { lane: current, clamped: reasons.length > 0, reasons };
}

interface InternalMatch {
  readonly match: RuleMatch;
  readonly rule: DetectorRule;
}

function compareInternal(a: InternalMatch, b: InternalMatch): number {
  return compareRuleMatches(a.match, b.match);
}

interface MatchEvalResult {
  readonly matched: boolean;
  readonly suppressed: boolean;
  readonly suppressedReason: SuppressedRule['reason'] | null;
  readonly evidence: RuleMatchEvidence;
}

const EMPTY_EVIDENCE: RuleMatchEvidence = Object.freeze({
  matchedText: null,
  metric: null,
  observed: null,
  expected: null,
  z: null,
});

function noMatch(): MatchEvalResult {
  return { matched: false, suppressed: false, suppressedReason: null, evidence: EMPTY_EVIDENCE };
}

function matchResult(evidence: RuleMatchEvidence): MatchEvalResult {
  return { matched: true, suppressed: false, suppressedReason: null, evidence };
}

function suppressedResult(reason: SuppressedRule['reason']): MatchEvalResult {
  return { matched: false, suppressed: true, suppressedReason: reason, evidence: EMPTY_EVIDENCE };
}

function evaluateLiteral(matcher: Extract<RuleMatcher, { type: 'literal' }>, ctx: LineEvalContext): MatchEvalResult {
  if (matcher.stream !== 'any' && matcher.stream !== ctx.stream) {
    return noMatch();
  }
  const haystackFull = matcher.target === 'raw' ? ctx.line : ctx.shape.template;
  const haystack = haystackFull.slice(0, MAX_LINE_MATCH_CHARS);
  const needle = matcher.caseSensitive ? matcher.needle : matcher.needle.toLowerCase();
  const hay = matcher.caseSensitive ? haystack : haystack.toLowerCase();
  if (!hay.includes(needle)) {
    return noMatch();
  }
  return matchResult({
    matchedText: matcher.needle.slice(0, 200),
    metric: null,
    observed: null,
    expected: null,
    z: null,
  });
}

function evaluateRegex(
  matcher: Extract<RuleMatcher, { type: 'regex' }>,
  regex: RegExp | null,
  ctx: LineEvalContext,
): MatchEvalResult {
  if (matcher.stream !== 'any' && matcher.stream !== ctx.stream) {
    return noMatch();
  }
  if (!regex) {
    return noMatch();
  }
  const haystackFull = matcher.target === 'raw' ? ctx.line : ctx.shape.template;
  const haystack = haystackFull.slice(0, MAX_LINE_MATCH_CHARS);
  const found = regex.exec(haystack);
  if (!found) {
    return noMatch();
  }
  return matchResult({ matchedText: found[0].slice(0, 200), metric: null, observed: null, expected: null, z: null });
}

function evaluateShape(shapeIds: ReadonlySet<string> | null, ctx: LineEvalContext): MatchEvalResult {
  if (!shapeIds || !shapeIds.has(ctx.shape.shapeId)) {
    return noMatch();
  }
  return matchResult({
    matchedText: ctx.shape.template.slice(0, 200),
    metric: null,
    observed: null,
    expected: null,
    z: null,
  });
}

function observedForMetric(
  matcher: Extract<RuleMatcher, { type: 'threshold' }>,
  metrics: WindowMetrics,
): number | null {
  switch (matcher.metric) {
    case 'lineCount':
      return metrics.lineCount;
    case 'stderrCount':
      return metrics.stderrCount;
    case 'stderrRatio':
      return metrics.stderrRatio;
    case 'shapeCount':
      return matcher.shapeId ? (metrics.shapeCounts.get(matcher.shapeId) ?? 0) : null;
  }
}

function verdictForMetric(metric: ThresholdMetric, metrics: WindowMetrics): RateVerdict | null {
  switch (metric) {
    case 'lineCount':
      return metrics.verdicts.lines;
    case 'stderrCount':
      return metrics.verdicts.stderr;
    case 'stderrRatio':
      return metrics.verdicts.stderrRatio;
    case 'shapeCount':
      return null;
  }
}

function evaluateThreshold(matcher: Extract<RuleMatcher, { type: 'threshold' }>, ctx: TickEvalContext): MatchEvalResult {
  if (matcher.sinceImageChangeMaxMs !== undefined) {
    if (ctx.sinceImageChangeMs === null || ctx.sinceImageChangeMs >= matcher.sinceImageChangeMaxMs) {
      return noMatch();
    }
  }
  const metrics = ctx.metrics;
  if (matcher.comparison === 'absolute') {
    const observed = observedForMetric(matcher, metrics);
    if (observed === null || observed < matcher.value) {
      return noMatch();
    }
    return matchResult({ matchedText: null, metric: matcher.metric, observed, expected: null, z: null });
  }
  const verdict = verdictForMetric(matcher.metric, metrics);
  if (!verdict || !verdict.trusted) {
    return suppressedResult('baseline-cold');
  }
  const compareValue = matcher.comparison === 'zScore' ? verdict.z : verdict.ratio;
  if (compareValue < matcher.value) {
    return noMatch();
  }
  return matchResult({
    matchedText: null,
    metric: matcher.metric,
    observed: verdict.observed,
    expected: verdict.expected,
    z: verdict.z,
  });
}

function evaluateSilenceMatcher(
  matcher: Extract<RuleMatcher, { type: 'silence' }>,
  metrics: WindowMetrics,
): MatchEvalResult {
  const silence = metrics.silence;
  if (!silence || silence.verdict !== 'anomalous' || silence.windowMs !== matcher.windowMs) {
    return noMatch();
  }
  return matchResult({
    matchedText: null,
    metric: 'silence',
    observed: silence.silentForMs,
    expected: silence.expectedPerTick,
    z: null,
  });
}

function evaluateEvent(matcher: Extract<RuleMatcher, { type: 'event' }>, event: ContainerStateEvent): MatchEvalResult {
  if (matcher.eventTypes.length > 0 && !matcher.eventTypes.includes(event.eventType)) {
    return noMatch();
  }
  if (matcher.oomKilled !== undefined && event.oomKilled !== matcher.oomKilled) {
    return noMatch();
  }
  if (matcher.exitCodeNonZero !== undefined) {
    const isNonZero = event.exitCode !== null && event.exitCode !== 0;
    if (isNonZero !== matcher.exitCodeNonZero) {
      return noMatch();
    }
  }
  if (matcher.healthStatus !== undefined && event.healthStatus !== matcher.healthStatus) {
    return noMatch();
  }
  if (matcher.minRestartsInWindow !== undefined && event.restartsInWindow < matcher.minRestartsInWindow) {
    return noMatch();
  }
  return matchResult({
    matchedText: event.eventType.slice(0, 200),
    metric: null,
    observed: event.restartsInWindow,
    expected: null,
    z: null,
  });
}

type NonCorrelateMatcher = Exclude<RuleMatcher, { readonly type: 'correlate' }>;

function evaluateMatcher(compiled: CompiledRule, ctx: RuleEvalContext): MatchEvalResult {
  const matcher = compiled.rule.matcher as NonCorrelateMatcher;
  switch (matcher.type) {
    case 'literal':
      return evaluateLiteral(matcher, ctx as LineEvalContext);
    case 'regex':
      return evaluateRegex(matcher, compiled.regex, ctx as LineEvalContext);
    case 'shape':
      return evaluateShape(compiled.shapeIds, ctx as LineEvalContext);
    case 'threshold':
      return evaluateThreshold(matcher, ctx as TickEvalContext);
    case 'silence':
      return evaluateSilenceMatcher(matcher, (ctx as TickEvalContext).metrics);
    case 'event':
      return evaluateEvent(matcher, (ctx as EventEvalContext).event);
  }
}

function isCanaryActive(rule: DetectorRule, at: number): boolean {
  return rule.canaryUntil !== null && at < rule.canaryUntil.getTime();
}

function buildRuleMatch(rule: DetectorRule, at: number, evidence: RuleMatchEvidence): RuleMatch {
  return {
    ruleId: rule.id,
    ruleVersion: rule.version,
    kind: rule.kind,
    lane: rule.lane,
    scopeSpecificity: scopeSpecificity(rule.scope),
    priority: rule.priority,
    updatedAt: rule.provenance.updatedAt.getTime(),
    hardSignal: rule.hardSignal,
    isCanary: isCanaryActive(rule, at),
    evidence,
  };
}

const EMPTY_MATCHES: readonly RuleMatch[] = Object.freeze([]);
const EMPTY_SHADOW: readonly ShadowRuleMatch[] = Object.freeze([]);
const EMPTY_SUPPRESSED: readonly SuppressedRule[] = Object.freeze([]);

function evaluateCorrelate(
  matcher: Extract<RuleMatcher, { type: 'correlate' }>,
  at: number,
  recentRuleMatches: ReadonlyMap<string, readonly number[]>,
): MatchEvalResult {
  const matched = matcher.ruleIds.every((id) => {
    const timestamps = recentRuleMatches.get(id) ?? [];
    return timestamps.some((t) => at - t >= 0 && at - t <= matcher.windowMs);
  });
  if (!matched) {
    return noMatch();
  }
  return matchResult({
    matchedText: matcher.ruleIds.join(',').slice(0, 200),
    metric: 'correlate',
    observed: null,
    expected: null,
    z: null,
  });
}

export function evaluateCompiled(set: CompiledRuleSet, ctx: RuleEvalContext): LaneDecision {
  const candidates = set.byTrigger[ctx.trigger];
  const suppressed: SuppressedRule[] = [];
  const activeInternal: InternalMatch[] = [];
  const shadowInternal: InternalMatch[] = [];
  const correlateCandidates: CompiledRule[] = [];

  for (const compiled of candidates) {
    const { rule } = compiled;
    if (!rule.enabled) continue;
    if (rule.state !== 'active' && rule.state !== 'shadow') continue;
    if (!ruleAppliesTo(rule, ctx)) continue;

    if (ctx.coldStart && !rule.hardSignal) {
      if (suppressed.length < MAX_SUPPRESSED_RECORDED) {
        suppressed.push({ ruleId: rule.id, reason: 'cold-start' });
      }
      continue;
    }

    if (rule.matcher.type === 'correlate') {
      correlateCandidates.push(compiled);
      continue;
    }

    const result = evaluateMatcher(compiled, ctx);
    if (result.suppressed) {
      if (suppressed.length < MAX_SUPPRESSED_RECORDED && result.suppressedReason) {
        suppressed.push({ ruleId: rule.id, reason: result.suppressedReason });
      }
      continue;
    }
    if (!result.matched) continue;

    const match = buildRuleMatch(rule, ctx.at, result.evidence);
    (rule.state === 'active' ? activeInternal : shadowInternal).push({ match, rule });
  }

  let mergedActive = ctx.recentRuleMatches;
  let mergedAll = ctx.recentRuleMatches;
  if (correlateCandidates.length > 0) {
    const active = new Map<string, number[]>();
    for (const [ruleId, timestamps] of ctx.recentRuleMatches) active.set(ruleId, timestamps.slice());
    for (const internal of activeInternal) {
      const arr = active.get(internal.rule.id) ?? [];
      arr.push(ctx.at);
      active.set(internal.rule.id, arr);
    }
    mergedActive = active;

    const all = new Map<string, number[]>();
    for (const [ruleId, timestamps] of active) all.set(ruleId, timestamps.slice());
    for (const internal of shadowInternal) {
      const arr = all.get(internal.rule.id) ?? [];
      arr.push(ctx.at);
      all.set(internal.rule.id, arr);
    }
    mergedAll = all;
  }

  for (const compiled of correlateCandidates) {
    const { rule } = compiled;
    if (rule.matcher.type !== 'correlate') continue;
    // A shadow rule's match is an unvetted signal and must not sway an active decision.
    const recentForRule = rule.state === 'active' ? mergedActive : mergedAll;
    const result = evaluateCorrelate(rule.matcher, ctx.at, recentForRule);
    if (!result.matched) continue;
    const match = buildRuleMatch(rule, ctx.at, result.evidence);
    (rule.state === 'active' ? activeInternal : shadowInternal).push({ match, rule });
  }

  activeInternal.sort(compareInternal);
  const decidingInternal = activeInternal[0] ?? null;
  const preClampLane = decidingInternal ? decidingInternal.match.lane : defaultLaneForTier(ctx.tier, ctx.coldStart);
  const activeMatches = activeInternal.map((i) => i.match);

  let lane = preClampLane;
  let clamped = false;
  let clampReasons: readonly string[] = [];

  if (decidingInternal) {
    const clampResult = clampLane(preClampLane, ctx, decidingInternal.rule, activeMatches);
    lane = clampResult.lane;
    clamped = clampResult.clamped;
    clampReasons = clampResult.reasons;
  }

  const shadowMatches: ShadowRuleMatch[] = [];
  let truncatedShadow = false;
  let counterfactualCount = 0;
  for (const internal of shadowInternal) {
    if (counterfactualCount >= MAX_SHADOW_COUNTERFACTUALS) {
      shadowMatches.push({
        ...internal.match,
        wouldBeLane: internal.match.lane,
        wouldChangeLane: internal.match.lane !== lane,
        wouldBeClamped: false,
      });
      truncatedShadow = true;
      continue;
    }
    counterfactualCount++;
    const counterfactualActive = [...activeInternal, internal].sort(compareInternal);
    const deciding = counterfactualActive[0];
    const counterfactualMatches = counterfactualActive.map((i) => i.match);
    const clampResult = clampLane(deciding.match.lane, ctx, deciding.rule, counterfactualMatches);
    shadowMatches.push({
      ...internal.match,
      wouldBeLane: clampResult.lane,
      wouldChangeLane: clampResult.lane !== lane,
      wouldBeClamped: clampResult.clamped,
    });
  }

  return {
    lane,
    source: decidingInternal ? 'rule' : 'default',
    decidingRuleId: decidingInternal ? decidingInternal.rule.id : null,
    preClampLane,
    clamped,
    clampReasons,
    matches: activeMatches.length > 0 ? activeMatches : EMPTY_MATCHES,
    shadow: shadowMatches.length > 0 ? shadowMatches : EMPTY_SHADOW,
    suppressed: suppressed.length > 0 ? suppressed : EMPTY_SUPPRESSED,
    truncatedShadow,
    shapeId: ctx.trigger === 'line' ? ctx.shape.shapeId : null,
  };
}

export function evaluateRules(rules: readonly DetectorRule[], ctx: RuleEvalContext): LaneDecision {
  return evaluateCompiled(compileRules(rules), ctx);
}

const SEED_PROVENANCE_DATE = new Date('2026-01-01T00:00:00.000Z');

function seedProvenance(rationale: string): RuleProvenance {
  return {
    origin: 'seed',
    proposedByRunId: null,
    proposedFromFindingId: null,
    rationale,
    createdAt: SEED_PROVENANCE_DATE,
    updatedAt: SEED_PROVENANCE_DATE,
    promotedAt: null,
  };
}

function seedRule(
  id: string,
  name: string,
  kind: RuleKind,
  matcher: RuleMatcher,
  lane: LogLane,
  appliesToTiers: readonly Tier[] | null,
  hardSignal: boolean,
  rationale: string,
  operatorApproved = true,
): DetectorRule {
  return {
    id,
    version: 1,
    name,
    kind,
    matcher,
    lane,
    state: 'active',
    enabled: true,
    scope: { kind: 'fleet' },
    appliesToTiers,
    priority: 0,
    hardSignal,
    operatorApproved,
    canaryUntil: null,
    cooldownMs: null,
    provenance: seedProvenance(rationale),
  };
}

export const SEEDED_RULES: readonly DetectorRule[] = [
  seedRule(
    'seed:level-fatal',
    'Fatal level token',
    'match',
    { type: 'regex', pattern: '\\b(FATAL|CRITICAL|EMERG)\\b', flags: '', target: 'raw', stream: 'any' },
    'triage',
    null,
    true,
    'Fatal-level log tokens are always worth waking the agent for.',
  ),
  seedRule(
    'seed:panic',
    'Panic or unhandled exception',
    'match',
    {
      type: 'regex',
      pattern: '\\bpanic:|\\b(?:PANIC|Unhandled exception|FATAL EXCEPTION)\\b',
      flags: '',
      target: 'raw',
      stream: 'any',
    },
    'triage',
    null,
    true,
    'A panic or unhandled exception is a hard crash signature.',
  ),
  seedRule(
    'seed:traceback',
    'Python traceback',
    'match',
    {
      type: 'literal',
      needle: 'Traceback (most recent call last)',
      caseSensitive: true,
      target: 'raw',
      stream: 'any',
    },
    'triage',
    null,
    true,
    'A Python traceback marks an unhandled exception.',
  ),
  seedRule(
    'seed:segfault',
    'Segmentation fault',
    'match',
    { type: 'regex', pattern: '\\b(segfault|SIGSEGV|Segmentation fault)\\b', flags: '', target: 'raw', stream: 'any' },
    'triage',
    null,
    true,
    'A segfault is a hard crash signature.',
  ),
  seedRule(
    'seed:oom-log',
    'Out of memory in application log',
    'match',
    {
      type: 'regex',
      pattern: '\\b(Out of memory|OutOfMemoryError|Cannot allocate memory|ENOMEM)\\b',
      flags: '',
      target: 'raw',
      stream: 'any',
    },
    'triage',
    null,
    true,
    'An application-level OOM message precedes or accompanies a kernel OOM kill.',
  ),
  seedRule(
    'seed:level-error-t0',
    'Error level token, tier 0',
    'match',
    { type: 'regex', pattern: '\\b(ERROR|ERR)\\b', flags: '', target: 'raw', stream: 'any' },
    'triage',
    [0],
    false,
    'Tier 0 containers get immediate investigation for any error-level line.',
  ),
  seedRule(
    'seed:level-error',
    'Error level token, tier 1/2',
    'match',
    { type: 'regex', pattern: '\\b(ERROR|ERR)\\b', flags: '', target: 'raw', stream: 'any' },
    'batch',
    [1, 2],
    false,
    'Lower-tier errors roll up into the batch digest instead of waking the agent.',
  ),
  seedRule(
    'seed:level-warn',
    'Warning level token',
    'match',
    { type: 'regex', pattern: '\\bWARN(?:ING)?\\b', flags: '', target: 'raw', stream: 'any' },
    'batch',
    null,
    false,
    'Warnings are routine enough to batch by default.',
  ),
  seedRule(
    'seed:oom-killed',
    'Container OOM killed',
    'state',
    { type: 'event', eventTypes: ['die'], oomKilled: true },
    'page',
    null,
    true,
    'An OOM kill is the highest-severity container state event.',
  ),
  seedRule(
    'seed:nonzero-exit',
    'Container exited non-zero',
    'state',
    { type: 'event', eventTypes: ['die'], exitCodeNonZero: true },
    'triage',
    null,
    true,
    'A non-zero exit needs investigation regardless of tier.',
  ),
  seedRule(
    'seed:crash-loop',
    'Crash loop, tier 0',
    'state',
    { type: 'event', eventTypes: ['start'], minRestartsInWindow: 3, windowMs: 600_000 },
    'page',
    [0],
    true,
    'Three restarts in ten minutes on a critical container is worth an instant page.',
  ),
  seedRule(
    'seed:crash-loop-lower',
    'Crash loop, tier 1/2',
    'state',
    { type: 'event', eventTypes: ['start'], minRestartsInWindow: 3, windowMs: 600_000 },
    'triage',
    [1, 2],
    true,
    'A crash loop on a lower tier still needs an investigation run, just not a page.',
  ),
  seedRule(
    'seed:health-failing',
    'Health check failing',
    'state',
    { type: 'event', eventTypes: ['health_status'], healthStatus: 'unhealthy' },
    'triage',
    null,
    true,
    'An unhealthy health check is an operational hard signal.',
  ),
  seedRule(
    'seed:stderr-burst',
    'Stderr rate burst',
    'threshold',
    { type: 'threshold', metric: 'stderrCount', comparison: 'zScore', value: 4, windowMs: 60_000 },
    'triage',
    null,
    false,
    'A statistically significant stderr burst against the adaptive baseline.',
  ),
  seedRule(
    'seed:line-burst',
    'Line rate burst',
    'threshold',
    { type: 'threshold', metric: 'lineCount', comparison: 'zScore', value: 4, windowMs: 60_000 },
    'batch',
    null,
    false,
    'A line-rate burst is worth surfacing in the digest without waking the agent.',
  ),
  seedRule(
    'seed:silence',
    'Unexpected silence',
    'silence',
    { type: 'silence', windowMs: 300_000 },
    'triage',
    [0, 1],
    false,
    'A container that normally logs has gone quiet.',
  ),
  seedRule(
    'seed:post-deploy-error-burst',
    'Post-deploy stderr burst',
    'threshold',
    {
      type: 'threshold',
      metric: 'stderrCount',
      comparison: 'baselineMultiple',
      value: 2,
      windowMs: 120_000,
      sinceImageChangeMaxMs: 900_000,
    },
    'triage',
    null,
    true,
    'A stderr burst shortly after an image change is the post-deploy watch window.',
  ),
];

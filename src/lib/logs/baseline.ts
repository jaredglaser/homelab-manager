export const BASELINE_STATE_VERSION = 1;
export const BASELINE_TICK_MS = 10_000;
export const BASELINE_ALPHA = 0.0228;
export const MAX_GAP_TICKS = 360;
export const SEASONAL_BUCKETS = 24;
export const SEASONAL_ALPHA = 0.25;
export const SEASONAL_MIN_SAMPLES = 5;
export const SEASONAL_MIN_TRUSTED_BUCKETS = 3;
export const SEASONAL_MIN_TICKS_PER_HOUR = 60;
export const SEASONAL_FACTOR_MIN = 0.25;
export const SEASONAL_FACTOR_MAX = 4;
export const COLD_START_MS = 7_200_000;
export const COLD_START_MIN_TICKS = 180;
export const SILENCE_MIN_EXPECTED_PER_TICK = 0.2;

const RATIO_EPSILON = 1e-9;

export interface EwmaState {
  readonly mean: number;
  readonly variance: number;
  readonly ticks: number;
}

export interface SeasonalBucket {
  readonly mean: number;
  readonly samples: number;
}

export interface BaselineState {
  readonly version: number;
  readonly entityId: string;
  readonly imageRef: string | null;
  readonly lines: EwmaState;
  readonly stderr: EwmaState;
  readonly seasonal: readonly SeasonalBucket[];
  readonly seasonalPartial: { readonly hour: number; readonly sum: number; readonly ticks: number } | null;
  readonly lastTickAt: number;
  readonly lastNonEmptyTickAt: number;
  readonly warmStartedAt: number;
  readonly totalTicks: number;
}

export interface TickObservation {
  readonly at: number;
  readonly lineCount: number;
  readonly stderrCount: number;
}

export interface BaselineThresholds {
  readonly multiple: number;
  readonly zThreshold: number;
  readonly minCountLines: number;
  readonly minCountStderr: number;
  readonly minLinesForRatio: number;
}

export const DEFAULT_THRESHOLDS: BaselineThresholds = {
  multiple: 3,
  zThreshold: 4,
  minCountLines: 5,
  minCountStderr: 3,
  minLinesForRatio: 20,
};

export type BaselineMetric = 'lines' | 'stderr' | 'stderrRatio';
export type BaselineVerdictLevel = 'normal' | 'elevated' | 'anomalous';

export interface RateVerdict {
  readonly metric: BaselineMetric;
  readonly observed: number;
  readonly expected: number;
  readonly ratio: number;
  readonly z: number;
  readonly sd: number;
  readonly windowMs: number;
  readonly seasonalFactor: number;
  readonly trusted: boolean;
  readonly verdict: BaselineVerdictLevel;
  readonly reason: 'ok' | 'cold-start' | 'below-floor' | 'insufficient-denominator';
}

export interface SilenceVerdict {
  readonly silentForMs: number;
  readonly windowMs: number;
  readonly expectedPerTick: number;
  readonly verdict: 'normal' | 'anomalous';
  readonly reason: 'ok' | 'cold-start' | 'baseline-too-quiet';
}

export interface ExpectedCounts {
  readonly lines: number;
  readonly stderr: number;
  readonly sdLines: number;
  readonly sdStderr: number;
  readonly seasonalFactor: number;
  readonly trusted: boolean;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function stepEwma(prev: EwmaState, x: number, alpha: number, ticksAdded: number): EwmaState {
  const delta = x - prev.mean;
  const mean = prev.mean + alpha * delta;
  const variance = (1 - alpha) * (prev.variance + alpha * delta * delta);
  return { mean, variance, ticks: prev.ticks + ticksAdded };
}

function hourOf(at: number): number {
  return new Date(at).getHours();
}

export function createBaselineState(entityId: string, now: number, imageRef: string | null = null): BaselineState {
  const seasonal: SeasonalBucket[] = [];
  for (let i = 0; i < SEASONAL_BUCKETS; i++) {
    seasonal.push({ mean: 0, samples: 0 });
  }
  return {
    version: BASELINE_STATE_VERSION,
    entityId,
    imageRef,
    lines: { mean: 0, variance: 0, ticks: 0 },
    stderr: { mean: 0, variance: 0, ticks: 0 },
    seasonal,
    seasonalPartial: null,
    lastTickAt: now,
    lastNonEmptyTickAt: now,
    warmStartedAt: now,
    totalTicks: 0,
  };
}

function foldSeasonalPartial(
  seasonal: readonly SeasonalBucket[],
  partial: { readonly hour: number; readonly sum: number; readonly ticks: number },
): readonly SeasonalBucket[] {
  if (partial.ticks < SEASONAL_MIN_TICKS_PER_HOUR) {
    return seasonal;
  }
  const bucketMean = partial.sum / partial.ticks;
  const bucket = seasonal[partial.hour];
  const delta = bucketMean - bucket.mean;
  const next = seasonal.slice();
  next[partial.hour] = { mean: bucket.mean + SEASONAL_ALPHA * delta, samples: bucket.samples + 1 };
  return next;
}

function advanceSeasonal(
  state: BaselineState,
  obs: TickObservation,
): { seasonal: readonly SeasonalBucket[]; seasonalPartial: NonNullable<BaselineState['seasonalPartial']> } {
  const hour = hourOf(obs.at);
  const partial = state.seasonalPartial;

  if (partial === null || partial.hour === hour) {
    const base = partial ?? { hour, sum: 0, ticks: 0 };
    return {
      seasonal: state.seasonal,
      seasonalPartial: { hour, sum: base.sum + obs.lineCount, ticks: base.ticks + 1 },
    };
  }

  const seasonal = foldSeasonalPartial(state.seasonal, partial);
  return {
    seasonal,
    seasonalPartial: { hour, sum: obs.lineCount, ticks: 1 },
  };
}

export function observeTick(state: BaselineState, obs: TickObservation): BaselineState {
  if (obs.at < state.lastTickAt) {
    return state;
  }

  const gapTicks = Math.max(1, Math.round((obs.at - state.lastTickAt) / BASELINE_TICK_MS));
  const missed = gapTicks - 1;

  let lines = state.lines;
  let stderr = state.stderr;
  let totalTicks = state.totalTicks;

  if (missed > 0) {
    const n = Math.min(missed, MAX_GAP_TICKS);
    const alphaEff = 1 - Math.pow(1 - BASELINE_ALPHA, n);
    lines = stepEwma(lines, 0, alphaEff, n);
    stderr = stepEwma(stderr, 0, alphaEff, n);
  }

  // totalTicks gates isColdStart on real observations only: the gap above decays the
  // EWMA but must not manufacture warm-up confidence from elapsed time with no data.
  lines = stepEwma(lines, obs.lineCount, BASELINE_ALPHA, 1);
  stderr = stepEwma(stderr, obs.stderrCount, BASELINE_ALPHA, 1);
  totalTicks += 1;

  const lastNonEmptyTickAt = obs.lineCount > 0 || obs.stderrCount > 0 ? obs.at : state.lastNonEmptyTickAt;
  const { seasonal, seasonalPartial } = advanceSeasonal(state, obs);

  return {
    ...state,
    lines,
    stderr,
    seasonal,
    seasonalPartial,
    lastTickAt: obs.at,
    lastNonEmptyTickAt,
    totalTicks,
  };
}

export function resetForImageChange(state: BaselineState, at: number, imageRef: string | null): BaselineState {
  return {
    ...state,
    lines: { mean: 0, variance: 0, ticks: 0 },
    stderr: { mean: 0, variance: 0, ticks: 0 },
    imageRef,
    warmStartedAt: at,
    totalTicks: 0,
    lastTickAt: at,
    lastNonEmptyTickAt: at,
  };
}

export function isColdStart(state: BaselineState, now: number): boolean {
  return now - state.warmStartedAt < COLD_START_MS || state.totalTicks < COLD_START_MIN_TICKS;
}

export function seasonalFactor(state: BaselineState, at: number): number {
  const hour = hourOf(at);
  const bucket = state.seasonal[hour];
  if (bucket === undefined || bucket.samples < SEASONAL_MIN_SAMPLES) {
    return 1.0;
  }
  const trusted = state.seasonal.filter((b) => b.samples >= SEASONAL_MIN_SAMPLES);
  if (trusted.length < SEASONAL_MIN_TRUSTED_BUCKETS) {
    return 1.0;
  }
  const grandMean = trusted.reduce((sum, b) => sum + b.mean, 0) / trusted.length;
  if (grandMean <= 0) {
    return 1.0;
  }
  return clamp(bucket.mean / grandMean, SEASONAL_FACTOR_MIN, SEASONAL_FACTOR_MAX);
}

export function expectedCounts(state: BaselineState, at: number, windowMs: number): ExpectedCounts {
  const factor = seasonalFactor(state, at);
  const windowTicks = windowMs / BASELINE_TICK_MS;
  const lines = state.lines.mean * factor * windowTicks;
  const stderr = state.stderr.mean * factor * windowTicks;
  const varLines = windowTicks * state.lines.variance * factor * factor;
  const varStderr = windowTicks * state.stderr.variance * factor * factor;
  return {
    lines,
    stderr,
    sdLines: Math.sqrt(Math.max(varLines, lines, 1)),
    sdStderr: Math.sqrt(Math.max(varStderr, stderr, 1)),
    seasonalFactor: factor,
    trusted: !isColdStart(state, at),
  };
}

function resolveVerdict(
  observed: number,
  expected: number,
  z: number,
  thresholds: BaselineThresholds,
): BaselineVerdictLevel {
  const meetsMultiple = observed >= thresholds.multiple * expected;
  const meetsZ = z >= thresholds.zThreshold;
  if (meetsMultiple && meetsZ) {
    return 'anomalous';
  }
  const meetsHalfMultiple = observed >= (thresholds.multiple / 2) * expected;
  const meetsHalfZ = z >= thresholds.zThreshold / 2;
  if (meetsHalfMultiple && meetsHalfZ) {
    return 'elevated';
  }
  return 'normal';
}

function evaluateStderrRatio(
  state: BaselineState,
  input: {
    readonly at: number;
    readonly windowMs: number;
    readonly observedCount: number;
    readonly observedLineCount?: number;
  },
  exp: ExpectedCounts,
  thresholds: BaselineThresholds,
): RateVerdict {
  const observedLineCount = input.observedLineCount ?? 0;
  const expected = state.stderr.mean / Math.max(state.lines.mean, RATIO_EPSILON);
  const observed = observedLineCount > 0 ? input.observedCount / observedLineCount : 0;
  // Floored at the resolution of a single stderr line (1 / observedLineCount^2): against
  // a baseline with expected == 0, the raw Bernoulli variance is also 0, and dividing by
  // RATIO_EPSILON alone turns one incidental stderr line into a z-score in the thousands.
  const singleCountFloor = 1 / (Math.max(observedLineCount, 1) * Math.max(observedLineCount, 1));
  const variance = Math.max(
    (expected * (1 - Math.min(expected, 1))) / Math.max(observedLineCount, 1),
    singleCountFloor,
    RATIO_EPSILON,
  );
  const sd = Math.sqrt(variance);
  const z = (observed - expected) / sd;
  const ratio = observed / Math.max(expected, RATIO_EPSILON);

  const base = {
    metric: 'stderrRatio' as const,
    observed,
    expected,
    ratio,
    z,
    sd,
    windowMs: input.windowMs,
    seasonalFactor: exp.seasonalFactor,
  };

  if (isColdStart(state, input.at)) {
    return { ...base, trusted: false, verdict: 'normal', reason: 'cold-start' };
  }
  if (observedLineCount < thresholds.minLinesForRatio) {
    return { ...base, trusted: true, verdict: 'normal', reason: 'insufficient-denominator' };
  }
  return { ...base, trusted: true, verdict: resolveVerdict(observed, expected, z, thresholds), reason: 'ok' };
}

export function evaluateRate(
  state: BaselineState,
  input: {
    readonly metric: BaselineMetric;
    readonly at: number;
    readonly windowMs: number;
    readonly observedCount: number;
    readonly observedLineCount?: number;
    readonly thresholds?: BaselineThresholds;
  },
): RateVerdict {
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  const exp = expectedCounts(state, input.at, input.windowMs);

  if (input.metric === 'stderrRatio') {
    return evaluateStderrRatio(state, input, exp, thresholds);
  }

  const isLines = input.metric === 'lines';
  const expected = isLines ? exp.lines : exp.stderr;
  const sd = isLines ? exp.sdLines : exp.sdStderr;
  const minCount = isLines ? thresholds.minCountLines : thresholds.minCountStderr;
  const observed = input.observedCount;
  const ratio = observed / Math.max(expected, RATIO_EPSILON);
  const z = (observed - expected) / sd;

  const base = {
    metric: input.metric,
    observed,
    expected,
    ratio,
    z,
    sd,
    windowMs: input.windowMs,
    seasonalFactor: exp.seasonalFactor,
  };

  if (isColdStart(state, input.at)) {
    return { ...base, trusted: false, verdict: 'normal', reason: 'cold-start' };
  }
  if (observed < minCount) {
    return { ...base, trusted: true, verdict: 'normal', reason: 'below-floor' };
  }
  return { ...base, trusted: true, verdict: resolveVerdict(observed, expected, z, thresholds), reason: 'ok' };
}

export function evaluateSilence(
  state: BaselineState,
  input: { readonly at: number; readonly windowMs?: number },
): SilenceVerdict {
  const windowMs = input.windowMs ?? 300_000;
  const at = input.at;
  const expectedPerTick = state.lines.mean * seasonalFactor(state, at);
  const silentForMs = Math.max(0, at - state.lastNonEmptyTickAt);

  if (isColdStart(state, at)) {
    return { silentForMs, windowMs, expectedPerTick, verdict: 'normal', reason: 'cold-start' };
  }
  if (expectedPerTick < SILENCE_MIN_EXPECTED_PER_TICK) {
    return { silentForMs, windowMs, expectedPerTick, verdict: 'normal', reason: 'baseline-too-quiet' };
  }
  return {
    silentForMs,
    windowMs,
    expectedPerTick,
    verdict: silentForMs >= windowMs ? 'anomalous' : 'normal',
    reason: 'ok',
  };
}

export function serializeBaselineState(state: BaselineState): string {
  return JSON.stringify(state);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidEwmaState(value: unknown): value is EwmaState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return isFiniteNumber(v.mean) && isFiniteNumber(v.variance) && isFiniteNumber(v.ticks);
}

function isValidSeasonalBucket(value: unknown): value is SeasonalBucket {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return isFiniteNumber(v.mean) && isFiniteNumber(v.samples);
}

function isValidSeasonalPartial(value: unknown): value is BaselineState['seasonalPartial'] {
  if (value === null) {
    return true;
  }
  if (typeof value !== 'object') {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    isFiniteNumber(v.hour) &&
    v.hour >= 0 &&
    v.hour < SEASONAL_BUCKETS &&
    isFiniteNumber(v.sum) &&
    isFiniteNumber(v.ticks)
  );
}

function isValidBaselineState(value: unknown): value is BaselineState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (v.version !== BASELINE_STATE_VERSION) {
    return false;
  }
  if (typeof v.entityId !== 'string') {
    return false;
  }
  if (v.imageRef !== null && typeof v.imageRef !== 'string') {
    return false;
  }
  if (!isValidEwmaState(v.lines) || !isValidEwmaState(v.stderr)) {
    return false;
  }
  if (!Array.isArray(v.seasonal) || v.seasonal.length !== SEASONAL_BUCKETS) {
    return false;
  }
  if (!v.seasonal.every(isValidSeasonalBucket)) {
    return false;
  }
  if (!isValidSeasonalPartial(v.seasonalPartial)) {
    return false;
  }
  return (
    isFiniteNumber(v.lastTickAt) &&
    isFiniteNumber(v.lastNonEmptyTickAt) &&
    isFiniteNumber(v.warmStartedAt) &&
    isFiniteNumber(v.totalTicks)
  );
}

export function parseBaselineState(raw: unknown, entityId: string, now: number): BaselineState {
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return createBaselineState(entityId, now);
  }

  if (!isValidBaselineState(parsed)) {
    return createBaselineState(entityId, now);
  }

  return { ...parsed, entityId };
}

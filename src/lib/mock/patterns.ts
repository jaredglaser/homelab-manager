import { createNoise2D } from 'simplex-noise';
import { mulberry32, hashCode } from '@/lib/mock/prng';

/** Clamp a value to [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Linear interpolation between a and b by factor t ∈ [0, 1]. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Smooth Hermite interpolation (3t^2 - 2t^3) for t ∈ [0, 1]. */
export function smoothstep(t: number): number {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
}

/**
 * Sine wave pattern centered around `base` with given `amplitude` and `periodMs`.
 * Phase is shifted per-entity so different entities don't all peak together.
 */
export function sine(
  timeMs: number,
  entity: string,
  base: number,
  amplitude: number,
  periodMs: number,
): number {
  const phase = (hashCode(entity) % 1000) / 1000 * Math.PI * 2;
  return base + amplitude * Math.sin((timeMs / periodMs) * Math.PI * 2 + phase);
}

/**
 * Deterministic noise for a given entity + metric + time.
 * Uses a seeded PRNG keyed on the entity and the time bucket.
 * `bucketMs` controls the granularity (larger = smoother changes).
 * Returns a value in [0, 1).
 */
export function noise(
  timeMs: number,
  entity: string,
  metric: string,
  bucketMs: number = 5000,
): number {
  const bucket = Math.floor(timeMs / bucketMs);
  const seed = hashCode(`${entity}/${metric}/${bucket}`);
  return mulberry32(seed)();
}

/**
 * Smooth noise: interpolates between adjacent noise buckets for
 * a continuous-looking signal rather than step changes.
 */
export function smoothNoise(
  timeMs: number,
  entity: string,
  metric: string,
  bucketMs: number = 5000,
): number {
  const bucket = Math.floor(timeMs / bucketMs);
  const t = (timeMs % bucketMs) / bucketMs;

  const seedA = hashCode(`${entity}/${metric}/${bucket}`);
  const seedB = hashCode(`${entity}/${metric}/${bucket + 1}`);
  const a = mulberry32(seedA)();
  const b = mulberry32(seedB)();

  return lerp(a, b, smoothstep(t));
}

/** Profile defining how a metric behaves for a specific entity. */
export interface MetricProfile {
  base: number;
  amplitude: number;
  periodMs: number;
  noiseLevel: number;
  noiseBucketMs?: number;
  min?: number;
  max?: number;
}

/**
 * Generate a metric value from a profile at a given time.
 * Combines a sine wave trend with smooth noise.
 */
export function generateMetric(
  timeMs: number,
  entity: string,
  metric: string,
  profile: MetricProfile,
): number {
  const trend = sine(timeMs, entity, profile.base, profile.amplitude, profile.periodMs);
  const n = smoothNoise(timeMs, entity, metric, profile.noiseBucketMs ?? 5000);
  const value = trend + (n - 0.5) * 2 * profile.noiseLevel;
  return clamp(value, profile.min ?? 0, profile.max ?? Infinity);
}

// ─── Simplex-Based Generator ──────────────────────────────────────────────────

/** Profile for multi-octave simplex noise metric generation. */
export interface SimplexProfile {
  base: number;
  amplitude: number;
  periods: [number, number, number, number];
  weights?: [number, number, number, number];
  min?: number;
  max?: number;
}

const DEFAULT_WEIGHTS: [number, number, number, number] = [0.5, 0.25, 0.15, 0.10];

/** Cache noise functions by seed to avoid rebuilding the 512-entry permutation table on every call. */
const noiseCache = new Map<number, (x: number, y: number) => number>();

function getCachedNoise2D(seed: number): (x: number, y: number) => number {
  let fn = noiseCache.get(seed);
  if (!fn) {
    fn = createNoise2D(mulberry32(seed));
    noiseCache.set(seed, fn);
  }
  return fn;
}

/**
 * Generate a metric value using 4 octaves of 2D simplex noise.
 *
 * Each octave is seeded deterministically from entity/metric/octave, producing
 * organic-looking signals without the obvious periodicity of sine waves.
 * Noise functions are cached per seed so the permutation table is built only once.
 *
 * When `sampleIntervalMs` is provided, octaves whose period is below the Nyquist
 * limit (2x sample interval) are clamped to the minimum safe period. This prevents
 * aliasing while preserving variation at all zoom levels.
 */
export function generateSimplexMetric(
  timeMs: number,
  entity: string,
  metric: string,
  profile: SimplexProfile,
  sampleIntervalMs?: number,
): number {
  const weights = profile.weights ?? DEFAULT_WEIGHTS;
  const minPeriod = sampleIntervalMs ? sampleIntervalMs * 2 : 0;

  let sum = 0;

  for (let i = 0; i < 4; i++) {
    const seed = hashCode(`${entity}/${metric}/${i}`);
    const noise2D = getCachedNoise2D(seed);
    const period = minPeriod > 0 ? Math.max(profile.periods[i], minPeriod) : profile.periods[i];
    const x = timeMs / period;
    const y = (seed % 1000) / 1000;
    sum += weights[i] * noise2D(x, y);
  }

  const value = profile.base + profile.amplitude * sum;
  return clamp(value, profile.min ?? 0, profile.max ?? Infinity);
}

// ─── Activity-Based Generator ─────────────────────────────────────────────────

/** The four I/O activity levels that model real workload patterns. */
export type ActivityLevel = 'idle' | 'low' | 'med' | 'high';

/** I/O metric values for one activity level. */
export interface ActivityValues {
  readBytes: number;
  writeBytes: number;
  readOps: number;
  writeOps: number;
}

/**
 * Activity-based I/O profile.
 *
 * Models four distinct workload states instead of a continuous sine wave:
 *   idle - no I/O (ops are always 0 when bytes are 0, enforced by design)
 *   low  - background metadata reads/writes
 *   med  - medium bandwidth, high IOPS (random access: VM databases, cache hits)
 *   high - high bandwidth, low IOPS (sequential: media streaming, large copies)
 *
 * Each state holds for `stateDurationMs`, then steps to the next. Only a brief
 * `transitionMs` window at the boundary is interpolated - the rest is flat.
 * Set `transitionMs: 0` for NVMe-style instant jumps.
 */
export interface ActivityProfile {
  /** How long each state holds before the next one is chosen (ms). */
  stateDurationMs: number;
  /** Relative probability weights: [idle, low, med, high]. Need not sum to 1. */
  weights: [number, number, number, number];
  /** Noise amplitude: fraction of the current value (0.12 = ±12% jitter). */
  noise: number;
  /**
   * How long the transition between two states lasts (ms).
   * 0 = instant step (NVMe). 2000–3000 = brief HDD spin-up.
   * Must be less than `stateDurationMs`.
   */
  transitionMs: number;
  /**
   * During idle state, max blip magnitude as a fraction of `low` state values.
   * Adds occasional brief spikes (ARC reads, metadata flushes, TRIM) so idle
   * periods aren't perfectly flat zero lines.
   * 0 = flat idle. 0.25 = blips up to 25% of `low` values. Default: 0.
   */
  idleBlipScale?: number;
  idle: ActivityValues;
  low: ActivityValues;
  med: ActivityValues;
  high: ActivityValues;
}

function pickLevel(
  key: string,
  bucket: number,
  weights: [number, number, number, number],
): ActivityLevel {
  const seed = hashCode(`${key}/activity/${bucket}`);
  const r = mulberry32(seed)();
  const total = weights[0] + weights[1] + weights[2] + weights[3];
  const p = r * total;
  if (p < weights[0]) return 'idle';
  if (p < weights[0] + weights[1]) return 'low';
  if (p < weights[0] + weights[1] + weights[2]) return 'med';
  return 'high';
}

/**
 * Generate correlated I/O metrics from an activity profile.
 *
 * Values are flat within each state bucket. Only the brief `transitionMs` window
 * at the bucket boundary is interpolated - so NVMe pools jump immediately while
 * HDD pools ramp over a second or two. The noise key is unique per entity so
 * individual disks in the same pool vary slightly around the shared state.
 *
 * During stable idle phases, occasional brief blips are added additively via
 * `spike()` - scaled to `idleBlipScale` * `low` state values. This avoids the
 * perfectly flat zero line that multiplicative noise produces on idle (0 * n = 0).
 */
export function generateActivityMetrics(
  timeMs: number,
  activityKey: string,
  noiseKey: string,
  profile: ActivityProfile,
): ActivityValues {
  const { stateDurationMs, weights, noise, transitionMs } = profile;
  const bucket = Math.floor(timeMs / stateDurationMs);
  const bucketOffset = timeMs % stateDurationMs;

  // Most of the time we're in the stable phase of the current bucket.
  // Only blend during the brief transition window at the START of a new bucket.
  let valA: ActivityValues;
  let valB: ActivityValues;
  let blend: number;
  let isStableIdle: boolean;

  const currentLevel = pickLevel(activityKey, bucket, weights);

  if (transitionMs > 0 && bucketOffset < transitionMs) {
    // Transition window: cross-fade from the previous bucket's state into this one
    valA = profile[pickLevel(activityKey, bucket - 1, weights)];
    valB = profile[currentLevel];
    blend = smoothstep(bucketOffset / transitionMs);
    isStableIdle = false; // suppress blips during cross-fade
  } else {
    // Stable phase: hold the current bucket's state value
    valA = profile[currentLevel];
    valB = valA;
    blend = 0;
    isStableIdle = currentLevel === 'idle';
  }

  // Per-entity noise: small jitter within the stable state so disks don't look identical
  const n = smoothNoise(timeMs, noiseKey, 'activity', 8_000);
  const noiseFactor = 1 + (n - 0.5) * 2 * noise;

  let readBytes  = Math.max(0, lerp(valA.readBytes,  valB.readBytes,  blend) * noiseFactor);
  let writeBytes = Math.max(0, lerp(valA.writeBytes, valB.writeBytes, blend) * noiseFactor);
  let readOps    = Math.max(0, lerp(valA.readOps,    valB.readOps,    blend) * noiseFactor);
  let writeOps   = Math.max(0, lerp(valA.writeOps,   valB.writeOps,   blend) * noiseFactor);

  // Idle blips: additive spikes during stable-idle to break the flat-zero line.
  // Uses activityKey (shared across all entities in a pool) so pool, vdev, and
  // disk rows all fire their blips at the same moment - pool values rise in sync
  // with their children. Each entity uses its own profile.low magnitude so the
  // values remain correctly scaled per hierarchy level.
  const blipScale = profile.idleBlipScale ?? 0;
  if (isStableIdle && blipScale > 0) {
    const bd = 2_000; // 2-second bell-shaped blip
    readBytes  += spike(timeMs, activityKey, 'idle/readBytes',  15_000, bd, profile.low.readBytes  * blipScale);
    readOps    += spike(timeMs, activityKey, 'idle/readOps',    15_000, bd, profile.low.readOps    * blipScale);
    writeBytes += spike(timeMs, activityKey, 'idle/writeBytes', 20_000, bd, profile.low.writeBytes * blipScale * 0.4);
    writeOps   += spike(timeMs, activityKey, 'idle/writeOps',   20_000, bd, profile.low.writeOps   * blipScale * 0.4);
  }

  return {
    readBytes:  Math.max(0, Math.round(readBytes)),
    writeBytes: Math.max(0, Math.round(writeBytes)),
    readOps:    Math.max(0, Math.round(readOps)),
    writeOps:   Math.max(0, Math.round(writeOps)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Occasional spike generator: produces a spike of `magnitude` that lasts `durationMs`
 * and recurs roughly every `intervalMs`. Deterministic per-entity.
 */
export function spike(
  timeMs: number,
  entity: string,
  metric: string,
  intervalMs: number,
  durationMs: number,
  magnitude: number,
): number {
  const cycle = Math.floor(timeMs / intervalMs);
  const seed = hashCode(`${entity}/${metric}/spike/${cycle}`);
  const rng = mulberry32(seed);
  // Only ~30% of cycles actually produce a spike
  if (rng() > 0.3) return 0;
  const offset = timeMs % intervalMs;
  // Spike starts at a deterministic point within the cycle
  const spikeStart = rng() * (intervalMs - durationMs);
  if (offset >= spikeStart && offset < spikeStart + durationMs) {
    const progress = (offset - spikeStart) / durationMs;
    // Bell-shaped spike: ramps up then down
    return magnitude * Math.sin(progress * Math.PI);
  }
  return 0;
}

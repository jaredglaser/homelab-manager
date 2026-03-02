import { mulberry32, hashCode } from './prng';

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

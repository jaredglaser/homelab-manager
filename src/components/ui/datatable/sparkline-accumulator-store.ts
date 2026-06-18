export interface SparklinePoint {
  timestamp: number;
  value: number;
}

const SPARKLINE_WINDOW_MS = 35000;
const STALE_THRESHOLD_MS = 1500;

// Grace window before an entity's accumulator is dropped after its last
// subscriber leaves. The virtualizer unmounts then immediately remounts rows
// when it repositions; keeping state briefly lets those rows resume instead of
// reseeding from scratch (CLAUDE.md gotcha 12).
const EVICTION_GRACE_MS = 30000;

const EMPTY: SparklinePoint[] = [];

type Phase = 'pending' | 'waiting' | 'seeded';

interface Series {
  points: SparklinePoint[];
  maxTs: number;
  phase: Phase;
}

const seriesByKey = new Map<string, Series>();
const subscribersByKey = new Map<string, Set<() => void>>();
const evictionTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function getSparklinePoints(key: string): SparklinePoint[] {
  return seriesByKey.get(key)?.points ?? EMPTY;
}

/**
 * Fold a fresh `data` window into the accumulator for `key`.
 *
 * Idempotent: replaying the same `data` leaves the stored points (and their
 * array reference) unchanged. That is what makes it safe to call during render,
 * the property the old per-instance ref mutation could not offer the React
 * Compiler. Until the latest point is fresh (within STALE_THRESHOLD_MS of
 * `now`) the series waits and renders a placeholder; the first fresh window
 * seeds it, and later windows append only points newer than the last seen
 * timestamp, dropping anything older than SPARKLINE_WINDOW_MS.
 */
export function ingestSparklineData(key: string, data: SparklinePoint[], now: number): void {
  if (data.length === 0) return;

  const prev = seriesByKey.get(key);
  const latest = data[data.length - 1].timestamp;

  if (!prev || prev.phase !== 'seeded') {
    if (now - latest > STALE_THRESHOLD_MS) {
      if (prev?.phase !== 'waiting') {
        seriesByKey.set(key, { points: prev?.points ?? EMPTY, maxTs: prev?.maxTs ?? 0, phase: 'waiting' });
      }
      return;
    }
    const cutoff = latest - SPARKLINE_WINDOW_MS;
    seriesByKey.set(key, { points: data.filter((d) => d.timestamp >= cutoff), maxTs: latest, phase: 'seeded' });
    return;
  }

  if (latest > prev.maxTs) {
    const cutoff = latest - SPARKLINE_WINDOW_MS;
    const newPoints = data.filter((d) => d.timestamp > prev.maxTs);
    seriesByKey.set(key, {
      points: [...prev.points, ...newPoints].filter((d) => d.timestamp >= cutoff),
      maxTs: latest,
      phase: 'seeded',
    });
  }
}

export function subscribeSparkline(key: string, callback: () => void): () => void {
  const timer = evictionTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    evictionTimers.delete(key);
  }

  let subscribers = subscribersByKey.get(key);
  if (!subscribers) {
    subscribers = new Set();
    subscribersByKey.set(key, subscribers);
  }
  subscribers.add(callback);

  return () => {
    subscribers.delete(callback);
    if (subscribers.size > 0) return;
    subscribersByKey.delete(key);
    evictionTimers.set(
      key,
      setTimeout(() => {
        seriesByKey.delete(key);
        evictionTimers.delete(key);
      }, EVICTION_GRACE_MS),
    );
  };
}

/** Test-only: clear all accumulator and subscriber state. */
export function resetSparklineStore(): void {
  seriesByKey.clear();
  subscribersByKey.clear();
  evictionTimers.forEach(clearTimeout);
  evictionTimers.clear();
}

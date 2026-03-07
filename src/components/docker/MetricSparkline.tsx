import { memo, useRef } from 'react';
import SparklineChart from '@/components/docker/SparklineChart';
import { resolveChartColors } from '@/lib/charts/css-vars';

const SPARKLINE_WINDOW_MS = 35000;
const STALE_THRESHOLD_MS = 1500;

// Toggle between 'none' (empty space) and 'pulse-line' (thin colored line)
const LOADING_STYLE = 'pulse-line' as 'none' | 'pulse-line';

interface MetricSparklineProps {
  /** Time-series data points sorted by timestamp */
  data: { timestamp: number; value: number }[];
  /** CSS variable for chart color (e.g., "--chart-cpu") */
  color: string;
}

/**
 * Self-contained sparkline with built-in accumulator and stale-data handling.
 *
 * Isolates sparkline data from chart buffer re-fetches by only accumulating
 * NEW data points (by timestamp). When cached data is stale (e.g., returning
 * to the page after navigation), shows a placeholder until fresh SSE data
 * arrives, then does a full seed with the last 35s window.
 *
 * Accumulation runs during render (not in an effect) to avoid scheduling a
 * second React commit after the parent's data update.
 */
export default memo(function MetricSparkline({ data, color }: MetricSparklineProps) {
  const accRef = useRef<{ timestamp: number; value: number }[]>([]);
  const maxTsRef = useRef(0);
  // 'pending' = first mount, 'waiting' = skipped stale data, 'seeded' = ready
  const stateRef = useRef<'pending' | 'waiting' | 'seeded'>('pending');

  // Render-time ref mutation — intentional and safe.
  //
  // These refs (stateRef, accRef, maxTsRef) are mutated during render instead of
  // using useState/useEffect. This is safe because updates are idempotent and fully
  // derived from the incoming `data` prop: the logic keys on the latest timestamp
  // and filters by a fixed cutoff (SPARKLINE_WINDOW_MS), so repeated renders with
  // the same data converge to the same ref state. This avoids scheduling a deferred
  // setState that would cause a second React commit per SSE tick (×168 sparklines).
  //
  // WARNING: Do not change the timestamp-based assumptions (e.g. switching to index-
  // based filtering or adding non-deterministic logic) without revisiting this pattern.
  if (data.length > 0) {
    const latest = data[data.length - 1].timestamp;

    if (stateRef.current !== 'seeded') {
      if (Date.now() - latest > STALE_THRESHOLD_MS) {
        stateRef.current = 'waiting';
      } else {
        stateRef.current = 'seeded';
        const cutoff = latest - SPARKLINE_WINDOW_MS;
        accRef.current = data.filter((d) => d.timestamp >= cutoff);
        maxTsRef.current = latest;
      }
    } else if (latest > maxTsRef.current) {
      const newPoints = data.filter((d) => d.timestamp > maxTsRef.current);
      const combined = [...accRef.current, ...newPoints];
      const cutoff = latest - SPARKLINE_WINDOW_MS;
      accRef.current = combined.filter((d) => d.timestamp >= cutoff);
      maxTsRef.current = latest;
    }
  }

  const points = accRef.current;

  if (points.length > 0) {
    return <SparklineChart data={points} color={color} className="hidden min-[1428px]:block" />;
  }

  // --- Option A: "none" — empty space, sparkline fades in via SparklineChart's own rendering ---
  // --- Option B: "pulse-line" — thin colored line at midpoint with gentle pulse animation ---
  if (LOADING_STYLE === 'none') {
    return null;
  }

  return <PulseLine color={color} />;
});

/** Thin horizontal line at the baseline with a shimmer that sweeps left-to-right. */
const PulseLine = memo(function PulseLine({ color }: { color: string }) {
  const lineColor = resolveChartColors(color).line;

  return (
    <div
      className="hidden min-[1428px]:flex items-end flex-shrink-0 overflow-hidden"
      style={{ width: 60, height: 24 }}
    >
      <div className="relative w-full" style={{ height: 2 }}>
        <div
          className="absolute inset-0 rounded-full"
          style={{ backgroundColor: lineColor, opacity: 0.15 }}
        />
        <div
          className="absolute inset-0 rounded-full sparkline-shimmer"
          style={{ backgroundColor: lineColor }}
        />
      </div>
    </div>
  );
});

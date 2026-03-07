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

  // Compute accumulated points during render (pure derivation from props + refs).
  // No useState/useEffect needed — avoids a second React commit per tick.
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

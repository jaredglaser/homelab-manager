import { memo, useCallback, useSyncExternalStore } from 'react';
import SparklineCanvas from '@/components/ui/datatable/SparklineCanvas';
import {
  getSparklinePoints,
  ingestSparklineData,
  subscribeSparkline,
  type SparklinePoint,
} from '@/components/ui/datatable/sparkline-accumulator-store';
import { resolveChartColors } from '@/lib/charts/css-vars';

// Toggle between 'none' (empty space) and 'pulse-line' (thin colored line)
const LOADING_STYLE = 'pulse-line' as 'none' | 'pulse-line';

interface SparklineCellProps {
  /** Time-series data points sorted by timestamp */
  data: SparklinePoint[];
  /** CSS variable for chart color (e.g., "--chart-cpu") */
  color: string;
  /** Stable, host-prefixed key for this series (entity id + metric) */
  seriesKey: string;
}

/**
 * Sparkline cell with stale-data handling.
 *
 * The accumulator lives in an external store keyed by seriesKey, so it survives
 * the unmount/remount the virtualizer triggers when repositioning rows (CLAUDE.md
 * gotcha 12). Ingest is idempotent and runs before the store read, so a data
 * update settles in a single commit (no second commit per SSE tick across the
 * many on-screen sparklines).
 */
export default memo(function SparklineCell({ data, color, seriesKey }: SparklineCellProps) {
  ingestSparklineData(seriesKey, data, Date.now());

  const subscribe = useCallback((cb: () => void) => subscribeSparkline(seriesKey, cb), [seriesKey]);
  const getSnapshot = useCallback(() => getSparklinePoints(seriesKey), [seriesKey]);
  const points = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  if (points.length > 0) {
    return <SparklineCanvas data={points} color={color} className="hidden min-[1428px]:block" />;
  }

  // "none" renders empty space; "pulse-line" shows a shimmer at midpoint
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
      className="hidden min-[1428px]:flex items-end shrink-0 overflow-hidden"
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

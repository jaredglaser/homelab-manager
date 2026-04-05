import { memo, type ReactNode } from 'react';
import SparklineCell from '@/components/shared-table/SparklineCell';
import { abbreviateUnit } from '@/lib/utils/abbreviate-unit';

/** Display placeholder for metrics with no value */
export const EMPTY_METRIC = '--';

interface MetricCellProps {
  /** The numeric value to display */
  value: string;
  /** The unit (e.g., "%", "MiB/s", "Kbps") */
  unit: string;
  /** Whether sparklines are visible */
  showSparklines: boolean;
  /** Whether to abbreviate unit labels */
  useAbbreviatedUnits: boolean;
  /** Pre-rendered sparkline element (e.g., LinearProgress). Prefer sparklineData+sparklineColor for memo. */
  sparkline?: ReactNode;
  /** Time-series data for auto-rendered SparklineCell */
  sparklineData?: { timestamp: number; value: number }[];
  /** CSS variable for sparkline color (e.g., "--chart-cpu") */
  sparklineColor?: string;
  /** Whether decimals are enabled - affects reserved width */
  hasDecimals?: boolean;
  /** Whether the data is stale (desaturate visuals) */
  isStale?: boolean;
}

export const MetricCell = memo(function MetricCell({
  value,
  unit,
  showSparklines,
  useAbbreviatedUnits,
  sparkline,
  sparklineData,
  sparklineColor,
  hasDecimals = false,
  isStale = false,
}: Readonly<MetricCellProps>) {

  // Reserve minimum space to prevent layout shift on typical values,
  // but allow growth for larger numbers (e.g., 5+ digit ops/s)
  const valueWidth = hasDecimals ? 'min-w-[6ch]' : 'min-w-[4ch]';

  const displayUnit = useAbbreviatedUnits ? abbreviateUnit(unit) : unit;
  // Abbreviated units are narrower, adjust width accordingly
  const unitWidth = useAbbreviatedUnits ? 'w-[2.5rem]' : 'w-[3.5rem]';

  // Render sparkline: prefer data+color props (memo-friendly), fall back to ReactNode
  // Check length to avoid creating sparklines for host/aggregate rows with empty arrays
  const dataSparkline = sparklineData?.length && sparklineColor
    ? <SparklineCell data={sparklineData} color={sparklineColor} />
    : null;
  const sparklineElement = showSparklines
    ? sparkline ?? dataSparkline
    : null;

  // Reserve space for sparkline when enabled (even if not passed) to keep columns aligned
  // SparklineCanvas dimensions: width=60px, height=24px, hidden on smaller screens via lg:block
  const sparklinePlaceholder = showSparklines && !sparklineElement ? (
    <div className="hidden min-[1428px]:block flex-shrink-0" style={{ width: 60, height: 24 }} />
  ) : null;

  const staleClass = isStale ? 'opacity-50 saturate-50' : '';

  return (
    <div className="flex items-center justify-end gap-2">
      {sparklineElement || sparklinePlaceholder}

      <span className={`${valueWidth} flex-shrink-0 text-right tabular-nums transition-opacity duration-200 ${staleClass}`}>
        {value}
      </span>

      <span className={`${unitWidth} min-w-0 text-left text-xs font-mono text-neutral-500 dark:text-neutral-400 transition-opacity duration-200 ${staleClass}`}>
        {displayUnit}
      </span>
    </div>
  );
});

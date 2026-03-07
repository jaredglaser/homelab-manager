import { memo, type ReactNode } from 'react';
import MetricSparkline from '@/components/docker/MetricSparkline';
import { useSettings } from '@/hooks/useSettings';
import { abbreviateUnit } from '@/lib/utils/abbreviate-unit';

/** Display placeholder for metrics with no value */
export const EMPTY_METRIC = '--';

interface MetricValueProps {
  /** The numeric value to display */
  value: string;
  /** The unit (e.g., "%", "MiB/s", "Kbps") */
  unit: string;
  /** Pre-rendered sparkline element (e.g., LinearProgress). Prefer sparklineData+sparklineColor for memo. */
  sparkline?: ReactNode;
  /** Time-series data for auto-rendered MetricSparkline */
  sparklineData?: { timestamp: number; value: number }[];
  /** CSS variable for sparkline color (e.g., "--chart-cpu") */
  sparklineColor?: string;
  /** Whether decimals are enabled - affects reserved width */
  hasDecimals?: boolean;
  /** Whether the data is stale (desaturate visuals) */
  isStale?: boolean;
}

export const MetricValue = memo(function MetricValue({
  value,
  unit,
  sparkline,
  sparklineData,
  sparklineColor,
  hasDecimals = false,
  isStale = false,
}: MetricValueProps) {
  const { general } = useSettings();
  const { useAbbreviatedUnits, showSparklines } = general;

  // Reserve minimum space to prevent layout shift on typical values,
  // but allow growth for larger numbers (e.g., 5+ digit ops/s)
  const valueWidth = hasDecimals ? 'min-w-[6ch]' : 'min-w-[4ch]';

  const displayUnit = useAbbreviatedUnits ? abbreviateUnit(unit) : unit;
  // Abbreviated units are narrower, adjust width accordingly
  const unitWidth = useAbbreviatedUnits ? 'w-[2.5rem]' : 'w-[3.5rem]';

  // Render sparkline: prefer data+color props (memo-friendly), fall back to ReactNode
  const sparklineElement = showSparklines
    ? sparkline ?? (sparklineData && sparklineColor
      ? <MetricSparkline data={sparklineData} color={sparklineColor} />
      : null)
    : null;

  // Reserve space for sparkline when enabled (even if not passed) to keep columns aligned
  // SparklineChart dimensions: width=60px, height=24px, hidden on smaller screens via lg:block
  const sparklinePlaceholder = showSparklines && !sparklineElement ? (
    <div className="hidden min-[1280px]:block flex-shrink-0" style={{ width: 60, height: 24 }} />
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

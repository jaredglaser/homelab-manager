import { memo, type ReactNode } from 'react';
import { useSettings } from '@/hooks/useSettings';
import { abbreviateUnit } from '@/lib/utils/abbreviate-unit';

interface MetricValueProps {
  /** The numeric value to display */
  value: string;
  /** The unit (e.g., "%", "MiB/s", "Kbps") */
  unit: string;
  /** Optional sparkline element to display before the value */
  sparkline?: ReactNode;
  /** Whether decimals are enabled - affects reserved width */
  hasDecimals?: boolean;
}

/**
 * Displays a metric value with consistent width handling.
 * Reserves appropriate space for the value based on whether decimals are enabled,
 * preventing layout shift when values change.
 */
export const MetricValue = memo(function MetricValue({
  value,
  unit,
  sparkline,
  hasDecimals = false,
}: MetricValueProps) {
  const { docker } = useSettings();
  const { useAbbreviatedUnits, showSparklines } = docker;

  // With decimals: need space for up to "999.99" (6 chars)
  // Without decimals: need space for up to "9999" (4 chars)
  // Using ch units for precise character-based width with tabular-nums
  const valueWidth = hasDecimals ? 'w-[6ch]' : 'w-[4ch]';

  const displayUnit = useAbbreviatedUnits ? abbreviateUnit(unit) : unit;
  // Abbreviated units are narrower, adjust width accordingly
  const unitWidth = useAbbreviatedUnits ? 'w-[2.5rem]' : 'w-[3.5rem]';

  // Reserve space for sparkline when enabled (even if not passed) to keep columns aligned
  // SparklineChart dimensions: width=60px, height=24px, hidden on smaller screens via lg:block
  const sparklinePlaceholder = showSparklines && !sparkline ? (
    <div className="hidden lg:block flex-shrink-0" style={{ width: 60, height: 24 }} />
  ) : null;

  return (
    <div className="flex items-center justify-end gap-2">
      {sparkline || sparklinePlaceholder}
      <span className={`${valueWidth} text-right tabular-nums`}>{value}</span>
      <span className={`${unitWidth} text-left text-xs font-mono text-neutral-500 dark:text-neutral-400`}>
        {displayUnit}
      </span>
    </div>
  );
});

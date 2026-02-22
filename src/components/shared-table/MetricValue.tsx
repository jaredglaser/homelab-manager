import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
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
  /** Color category for glow animation (cpu, memory, read, write) */
  color?: 'cpu' | 'memory' | 'read' | 'write';
  /** Whether the data is stale (desaturate visuals) */
  isStale?: boolean;
}

/**
 * Displays a metric value with consistent width handling.
 * Reserves appropriate space for the value based on whether decimals are enabled,
 * preventing layout shift when values change.
 * Applies a color-coded glow animation when the value updates.
 */
export const MetricValue = memo(function MetricValue({
  value,
  unit,
  sparkline,
  hasDecimals = false,
  color,
  isStale = false,
}: MetricValueProps) {
  const { general } = useSettings();
  const { useAbbreviatedUnits, showSparklines } = general;
  const previousValueRef = useRef<string>(value);
  const [isGlowing, setIsGlowing] = useState(false);

  // Detect value changes and trigger glow animation
  useEffect(() => {
    if (color && previousValueRef.current !== value) {
      previousValueRef.current = value;
      setIsGlowing(true);

      const glowTimer = setTimeout(() => setIsGlowing(false), 600);

      return () => {
        clearTimeout(glowTimer);
      };
    }
    previousValueRef.current = value;
  }, [value, color]);

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
    <div className="hidden min-[1280px]:block flex-shrink-0" style={{ width: 60, height: 24 }} />
  ) : null;

  const glowClass = color && isGlowing ? `metric-value-glow-${color}` : '';
  const staleClass = isStale ? 'opacity-50 saturate-50' : '';

  return (
    <div className="flex items-center justify-end gap-2">
      {sparkline || sparklinePlaceholder}

      <span className={`${valueWidth} flex-shrink-0 text-right tabular-nums transition-opacity duration-200 ${glowClass} ${staleClass}`}>
        {value}
      </span>

      <span className={`${unitWidth} min-w-0 text-left text-xs font-mono text-neutral-500 dark:text-neutral-400 transition-opacity duration-200 ${staleClass}`}>
        {displayUnit}
      </span>
    </div>
  );
});

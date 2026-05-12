import { memo, type ReactNode } from 'react';
import { useGeneralSettings } from '@/hooks/useSettings';

/**
 * Column header that aligns with MetricCell's value portion.
 * Renders left-to-right: optional sparkline spacer, label, then a unit-width spacer.
 * The unit-width spacer mirrors MetricCell's unit span so column text aligns
 * even when abbreviated and full unit labels differ in width.
 */
export const MetricHeaderCell = memo(function MetricHeaderCell({ children }: { children: ReactNode }) {
  const { general } = useGeneralSettings();
  const { useAbbreviatedUnits, showSparklines } = general;
  const unitWidth = useAbbreviatedUnits ? 'w-[2.5rem]' : 'w-[3.5rem]';

  return (
    <div className="flex items-center gap-2">
      {showSparklines && (
        <div className="hidden min-[1428px]:block flex-shrink-0" style={{ width: 60 }} />
      )}
      <span className="flex-shrink-0 font-semibold text-sm whitespace-nowrap">{children}</span>
      <span className={`${unitWidth} min-w-0`} />
    </div>
  );
});

import { memo, type ReactNode } from 'react';
import { useSettings } from '@/hooks/useSettings';

/**
 * Column header that aligns with MetricValue's value portion.
 * Uses the same flex justify-end + gap-2 layout with a matching unit-width spacer.
 * With justify-end, the header text right-edge always aligns with MetricValue's
 * value right-edge (both sit at: cell_right - unitWidth - gap) regardless of
 * text width. Tables use overflow-x-auto so nothing needs to shrink.
 */
export const MetricHeader = memo(function MetricHeader({ children }: { children: ReactNode }) {
  const { general } = useSettings();
  const { useAbbreviatedUnits, showSparklines } = general;
  const unitWidth = useAbbreviatedUnits ? 'w-[2.5rem]' : 'w-[3.5rem]';

  return (
    <div className="flex items-center justify-end gap-2">
      {showSparklines && (
        <div className="hidden min-[1280px]:block flex-shrink-0" style={{ width: 60 }} />
      )}
      <span className="flex-shrink-0 font-semibold text-sm whitespace-nowrap">{children}</span>
      <span className={`${unitWidth} min-w-0`} />
    </div>
  );
});

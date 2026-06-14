import type { ComponentProps } from 'react';
import { Progress as ProgressPrimitive } from '@base-ui/react/progress';
import { cn } from '@/lib/utils/cn';

/* 4px track in a 30% tint of the indicator color.
   Override the bar color per usage (e.g. capacity thresholds) via indicatorClassName. */
function Progress({
  className,
  indicatorClassName,
  children,
  ...props
}: ComponentProps<typeof ProgressPrimitive.Root> & { indicatorClassName?: string }) {
  return (
    <ProgressPrimitive.Root data-slot="progress" {...props}>
      <ProgressPrimitive.Track
        data-slot="progress-track"
        className={cn('bg-primary/30 relative h-1 w-full overflow-hidden rounded-full', className)}
      >
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className={cn('bg-primary h-full rounded-full transition-all', indicatorClassName)}
        />
      </ProgressPrimitive.Track>
      {children}
    </ProgressPrimitive.Root>
  );
}

export { Progress };

import type { ComponentProps } from 'react';
import { Progress as ProgressPrimitive } from '@base-ui/react/progress';
import { cn } from '@/lib/utils/cn';

/* Replaces MUI LinearProgress: 4px track in a 50% primary tint, primary indicator. */
function Progress({
  className,
  children,
  ...props
}: ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root data-slot="progress" {...props}>
      <ProgressPrimitive.Track
        data-slot="progress-track"
        className={cn('bg-primary/30 relative h-1 w-full overflow-hidden rounded-full', className)}
      >
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className="bg-primary h-full rounded-full transition-all"
        />
      </ProgressPrimitive.Track>
      {children}
    </ProgressPrimitive.Root>
  );
}

export { Progress };

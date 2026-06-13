import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils/cn';

function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn('bg-foreground/11 animate-pulse rounded-lg', className)}
      {...props}
    />
  );
}

export { Skeleton };

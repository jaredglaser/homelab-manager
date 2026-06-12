import type { ComponentProps } from 'react';
import { LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

/* Replaces MUI CircularProgress: primary color, 40px default like MUI. */
function Spinner({ className, ...props }: ComponentProps<typeof LoaderCircle>) {
  return (
    <LoaderCircle
      data-slot="spinner"
      role="progressbar"
      aria-label="Loading"
      className={cn('size-10 animate-spin text-primary', className)}
      {...props}
    />
  );
}

export { Spinner };

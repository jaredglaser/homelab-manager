import type { ComponentProps } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils/cn';

/*
 * Severity variants mirror MUI Alert's standard variant: a tint of the
 * severity color as background with the color itself for text and icon.
 * color-mix against the card background keeps the tint readable in both
 * color schemes without per-scheme overrides.
 */
const alertVariants = cva(
  'relative w-full rounded-lg px-4 py-3 text-sm grid has-[>svg]:grid-cols-[calc(var(--spacing)*5)_1fr] grid-cols-[0_1fr] has-[>svg]:gap-x-3 gap-y-0.5 items-start [&>svg]:size-5 [&>svg]:translate-y-0.5',
  {
    variants: {
      variant: {
        default: 'bg-card text-card-foreground border border-border',
        info: 'bg-[color-mix(in_srgb,var(--info)_12%,var(--card))] text-info [&>svg]:text-info',
        success: 'bg-[color-mix(in_srgb,var(--success)_12%,var(--card))] text-success [&>svg]:text-success',
        warning: 'bg-[color-mix(in_srgb,var(--warning)_12%,var(--card))] text-warning [&>svg]:text-warning',
        error: 'bg-[color-mix(in_srgb,var(--destructive)_12%,var(--card))] text-destructive [&>svg]:text-destructive',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Alert({
  className,
  variant,
  ...props
}: ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return (
    <div data-slot="alert" role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
  );
}

function AlertTitle({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-title"
      className={cn('col-start-2 line-clamp-1 min-h-4 font-medium', className)}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-description"
      className={cn('col-start-2 grid justify-items-start gap-1 [&_p]:leading-relaxed', className)}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription };

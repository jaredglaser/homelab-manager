import { ToggleGroup as ToggleGroupPrimitive } from '@base-ui/react/toggle-group';
import { Toggle as TogglePrimitive } from '@base-ui/react/toggle';
import { cn } from '@/lib/utils/cn';

/*
 * Styled like MUI ToggleButtonGroup size="small": connected outlined buttons
 * with a primary-tinted pressed state. Base UI's group value is always an
 * array; exclusive selection is enforced at call sites via toggleMultiple
 * (default false keeps single-select semantics like MUI's `exclusive`).
 */
function ToggleGroup({ className, ...props }: ToggleGroupPrimitive.Props<string>) {
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      className={cn('inline-flex items-stretch rounded-lg', className)}
      {...props}
    />
  );
}

function ToggleGroupItem({ className, ...props }: TogglePrimitive.Props) {
  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      className={cn(
        'inline-flex items-center justify-center gap-1 border border-foreground/15 px-2.5 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors outline-none first:rounded-l-lg last:rounded-r-lg not-first:-ml-px hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[pressed]:bg-primary/15 data-[pressed]:text-primary data-[pressed]:border-primary/40 data-[pressed]:z-10',
        className,
      )}
      {...props}
    />
  );
}

export { ToggleGroup, ToggleGroupItem };

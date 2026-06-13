import type { ComponentProps } from 'react';
import { Select as SelectPrimitive } from '@base-ui/react/select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

function Select<Value>(props: Readonly<SelectPrimitive.Root.Props<Value, false>>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectValue(props: ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

function SelectTrigger({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        'flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-foreground/25 bg-transparent px-3 py-1 text-sm whitespace-nowrap transition-colors outline-none hover:border-foreground focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50 data-[popup-open]:border-primary data-[popup-open]:ring-1 data-[popup-open]:ring-primary',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon>
        <ChevronDown className="size-4 opacity-60" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Popup>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner className="z-50 outline-none" sideOffset={4}>
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(
            'bg-popover text-popover-foreground max-h-[min(24rem,var(--available-height))] min-w-[var(--anchor-width)] overflow-y-auto rounded-lg py-1 shadow-lg outline-none transition-[opacity] data-[starting-style]:opacity-0 data-[ending-style]:opacity-0',
            className,
          )}
          {...props}
        >
          {children}
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        'grid w-full cursor-default grid-cols-[1fr_auto] items-center gap-2 px-4 py-2 text-sm outline-none select-none data-[highlighted]:bg-accent data-[selected]:bg-primary/10',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator>
        <Check className="size-4" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export { Select, SelectValue, SelectTrigger, SelectContent, SelectItem };

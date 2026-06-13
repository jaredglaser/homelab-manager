import type { ComponentProps } from 'react';
import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible';
import { cn } from '@/lib/utils/cn';

function Collapsible(props: ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger(props: ComponentProps<typeof CollapsiblePrimitive.Trigger>) {
  return <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />;
}

/*
 * The height transition runs on CSS via Base UI's
 * --collapsible-panel-height var, which is what lets detail panels keep
 * animating under the DataTable's content-visibility path (below the 150-row
 * virtualization threshold) without a JS animation system fighting the
 * virtualizer. See CLAUDE.md gotcha on Collapse + virtualizer.
 */
function CollapsibleContent({ className, ...props }: ComponentProps<typeof CollapsiblePrimitive.Panel>) {
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-content"
      className={cn(
        'h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-300 ease-in-out data-[starting-style]:h-0 data-[ending-style]:h-0',
        className,
      )}
      {...props}
    />
  );
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };

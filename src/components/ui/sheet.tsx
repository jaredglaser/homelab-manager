import type { ComponentProps } from 'react';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils/cn';

function Sheet(props: Readonly<ComponentProps<typeof DialogPrimitive.Root>>) {
  return <DialogPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger(props: Readonly<ComponentProps<typeof DialogPrimitive.Trigger>>) {
  return <DialogPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose(props: Readonly<ComponentProps<typeof DialogPrimitive.Close>>) {
  return <DialogPrimitive.Close data-slot="sheet-close" {...props} />;
}

const sheetVariants = cva(
  'bg-card text-card-foreground fixed z-50 flex flex-col shadow-xl outline-none transition-transform duration-200 ease-out',
  {
    variants: {
      side: {
        left: 'inset-y-0 left-0 h-dvh w-[min(20rem,85vw)] border-r border-border data-[starting-style]:-translate-x-full data-[ending-style]:-translate-x-full',
        right:
          'inset-y-0 right-0 h-dvh w-[min(20rem,85vw)] border-l border-border data-[starting-style]:translate-x-full data-[ending-style]:translate-x-full',
        bottom:
          'inset-x-0 bottom-0 max-h-[85dvh] rounded-t-2xl border-t border-border data-[starting-style]:translate-y-full data-[ending-style]:translate-y-full',
      },
    },
    defaultVariants: { side: 'left' },
  },
);

type SheetContentProps = ComponentProps<typeof DialogPrimitive.Popup> &
  VariantProps<typeof sheetVariants>;

/**
 * Slide-in panel. `bottom` is the phone-friendly default for pickers and
 * actions; `left`/`right` suit navigation. Height uses `dvh` so the panel does
 * not sit under a mobile browser's retracting URL bar, and the safe-area pad
 * keeps the last row clear of the iOS home indicator.
 */
function SheetContent({ className, children, side, ...props }: SheetContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        data-slot="sheet-backdrop"
        className="fixed inset-0 z-50 bg-black/50 transition-opacity duration-200 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0"
      />
      <DialogPrimitive.Popup
        data-slot="sheet-content"
        data-side={side ?? 'left'}
        className={cn(sheetVariants({ side }), className)}
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

function SheetHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-header"
      className={cn(
        'flex items-center gap-2 border-b border-border px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]',
        className,
      )}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="sheet-title"
      className={cn('text-base font-semibold', className)}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-muted-foreground text-sm', className)}
      {...props}
    />
  );
}

function SheetBody({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-body"
      className={cn(
        'themed-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[max(1rem,env(safe-area-inset-bottom))]',
        className,
      )}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn(
        'flex items-center justify-end gap-2 border-t border-border p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]',
        className,
      )}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetBody,
  SheetFooter,
  sheetVariants,
};

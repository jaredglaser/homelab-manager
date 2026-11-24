import type { ComponentProps } from 'react';
import { AlertDialog as AlertDialogPrimitive } from '@base-ui/react/alert-dialog';
import { cn } from '@/lib/utils/cn';
import { ModalBusyScope, ModalRootProvider, useModalBusy, useModalPopup, useModalRoot, type ModalBusyProps } from '@/components/ui/modal-busy';

/*
 * Confirmation dialog for decisions that must not be dismissed by accident.
 * Base UI's AlertDialog renders role="alertdialog" and, unlike Dialog, ignores
 * backdrop clicks, so the user has to pick an action. Escape still closes it.
 * Mirrors dialog.tsx styling.
 */

type AlertDialogProps = ComponentProps<typeof AlertDialogPrimitive.Root> & ModalBusyProps;

function AlertDialog({ busy, onOpenChange, ...props }: Readonly<AlertDialogProps>) {
  const root = useModalRoot({ kind: 'AlertDialog', busy, open: props.open, defaultOpen: props.defaultOpen, onOpenChange });
  return (
    <ModalRootProvider value={root.value}>
      <AlertDialogPrimitive.Root data-slot="alert-dialog" onOpenChange={root.onOpenChange} {...props} />
    </ModalRootProvider>
  );
}

function AlertDialogTrigger(props: Readonly<ComponentProps<typeof AlertDialogPrimitive.Trigger>>) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

function AlertDialogClose({ disabled, ...props }: Readonly<ComponentProps<typeof AlertDialogPrimitive.Close>>) {
  const busy = useModalBusy();
  return <AlertDialogPrimitive.Close data-slot="alert-dialog-close" disabled={disabled || busy} {...props} />;
}

function AlertDialogContent({ className, children, ref, ...props }: ComponentProps<typeof AlertDialogPrimitive.Popup>) {
  const popupRef = useModalPopup(ref);
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Backdrop
        data-slot="alert-dialog-backdrop"
        className="fixed inset-0 z-50 bg-black/50 transition-opacity duration-150 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0"
      />
      <AlertDialogPrimitive.Popup
        ref={popupRef}
        data-slot="alert-dialog-content"
        className={cn(
          'bg-card text-card-foreground fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100%-64px)] w-[calc(100%-64px)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg shadow-xl outline-none transition-[opacity,transform] duration-150 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
          className,
        )}
        {...props}
      >
        <ModalBusyScope>{children}</ModalBusyScope>
      </AlertDialogPrimitive.Popup>
    </AlertDialogPrimitive.Portal>
  );
}

function AlertDialogTitle({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn('px-6 py-4 text-xl font-medium', className)}
      {...props}
    />
  );
}

function AlertDialogDescription({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn('text-muted-foreground px-6 pb-2 text-sm', className)}
      {...props}
    />
  );
}

function AlertDialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn('flex items-center justify-end gap-2 p-2', className)}
      {...props}
    />
  );
}

export {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
};

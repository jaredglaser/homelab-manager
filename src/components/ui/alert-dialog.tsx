import type { ComponentProps } from 'react';
import { AlertDialog as AlertDialogPrimitive } from '@base-ui/react/alert-dialog';
import { cn } from '@/lib/utils/cn';

/*
 * Confirmation dialog for decisions that must not be dismissed by accident.
 * Base UI's AlertDialog renders role="alertdialog" and, unlike Dialog, does not
 * light-dismiss on backdrop click or Escape, so the user has to pick an action.
 * Mirrors dialog.tsx styling.
 */

function AlertDialog(props: Readonly<ComponentProps<typeof AlertDialogPrimitive.Root>>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogTrigger(props: Readonly<ComponentProps<typeof AlertDialogPrimitive.Trigger>>) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

function AlertDialogClose(props: Readonly<ComponentProps<typeof AlertDialogPrimitive.Close>>) {
  return <AlertDialogPrimitive.Close data-slot="alert-dialog-close" {...props} />;
}

function AlertDialogContent({ className, children, ...props }: ComponentProps<typeof AlertDialogPrimitive.Popup>) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Backdrop
        data-slot="alert-dialog-backdrop"
        className="fixed inset-0 z-50 bg-black/50 transition-opacity duration-150 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0"
      />
      <AlertDialogPrimitive.Popup
        data-slot="alert-dialog-content"
        className={cn(
          'bg-card text-card-foreground fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100%-64px)] w-[calc(100%-64px)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg shadow-xl outline-none transition-[opacity,transform] duration-150 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
          className,
        )}
        {...props}
      >
        {children}
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

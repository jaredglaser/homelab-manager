import type { ReactNode } from 'react';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils/cn';

interface FieldControlProps {
  id: string;
  'aria-invalid': boolean;
  'aria-describedby': string | undefined;
}

interface FieldProps {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  /** Replaces the hint. Its line is reserved either way, so a message appearing on blur cannot move a button out from under a click. */
  error?: string;
  className?: string;
  children: (control: FieldControlProps) => ReactNode;
}

function FieldError({ id, children }: Readonly<{ id?: string; children: ReactNode }>) {
  return (
    <p id={id} role="alert" data-slot="field-error" className="min-h-4 text-xs text-destructive">
      {children}
    </p>
  );
}

function Field({ id, label, hint, error, className, children }: Readonly<FieldProps>) {
  const messageId = `${id}-message`;
  const hasMessage = Boolean(error) || Boolean(hint);
  return (
    <div data-slot="field" className={cn('flex flex-col gap-1', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children({ id, 'aria-invalid': Boolean(error), 'aria-describedby': hasMessage ? messageId : undefined })}
      {error ? (
        <FieldError id={messageId}>{error}</FieldError>
      ) : (
        <p id={hasMessage ? messageId : undefined} data-slot="field-hint" className="min-h-4 text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

export { Field, FieldError };

import type { ReactNode } from 'react';
import type { UseFormRegisterReturn } from 'react-hook-form';
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
  /** Replaces the hint. Two lines are reserved either way, so a message that wraps at phone width cannot move a button out from under a click. */
  error?: string;
  className?: string;
  children: (control: FieldControlProps) => ReactNode;
}

export interface FieldIssue {
  field: string;
  message: string;
}

function FieldError({ id, children }: Readonly<{ id?: string; children: ReactNode }>) {
  return (
    <p id={id} role="alert" data-slot="field-error" className="min-h-8 text-xs text-destructive">
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
        <p id={hasMessage ? messageId : undefined} data-slot="field-hint" className="min-h-8 text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * Why the action beside it is off while a field it needs is still empty and untouched. Once the field is left its own
 * message takes over, so a value being typed is never judged before the user leaves the field.
 */
function blockedReason(
  issues: readonly FieldIssue[],
  state: { isTouched: (field: string) => boolean; isEmpty: (field: string) => boolean },
): string | null {
  return issues.find((issue) => !state.isTouched(issue.field) && state.isEmpty(issue.field))?.message ?? null;
}

/** A change to a field the user is not in, such as browser autofill, is judged as if the user had typed it and left. */
function checkedOnFill<T extends UseFormRegisterReturn>(registration: T): T {
  return {
    ...registration,
    onChange: async (event: { target: unknown; type?: unknown }) => {
      await registration.onChange(event);
      if (event.target !== document.activeElement) await registration.onBlur({ target: event.target, type: 'blur' });
    },
  };
}

function fieldIssues(result: { error?: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } }): FieldIssue[] {
  const byField = new Map<string, string>();
  for (const issue of result.error?.issues ?? []) {
    const field = String(issue.path[0] ?? '');
    if (!byField.has(field)) byField.set(field, issue.message);
  }
  return [...byField].map(([field, message]) => ({ field, message }));
}

function ActionReason({ children, className }: Readonly<{ children: ReactNode; className?: string }>) {
  return (
    <p data-slot="action-reason" aria-live="polite" className={cn('text-xs text-muted-foreground', className)}>
      {children}
    </p>
  );
}

export { Field, FieldError, ActionReason, blockedReason, checkedOnFill, fieldIssues };

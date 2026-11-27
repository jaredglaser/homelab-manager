import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from '@/components/ui/dialog';
import { checkedOnFill, ActionReason, Field, blockedReason, fieldIssues } from '@/components/ui/field';
import type { ServerFailureCopy } from '@/lib/errors/server-fn-error-copy';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { createStackSchema } from '@/data/stacks/schemas';

const createStackFormSchema = createStackSchema.extend({
  stackName: z.string().trim().pipe(createStackSchema.shape.stackName),
});
type CreateStackInput = z.infer<typeof createStackFormSchema>;

const NO_HOSTS_REASON = 'Add a host under Settings, then Managed Hosts.';

interface CreateStackDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: CreateStackInput) => void;
  hosts: string[];
  isLoading: boolean;
  error?: ServerFailureCopy | null;
}

export default function CreateStackDialog({
  open,
  onClose,
  onSubmit,
  hosts,
  isLoading,
  error,
}: CreateStackDialogProps) {
  const form = useForm<CreateStackInput>({
    mode: 'onTouched',
    defaultValues: { stackName: '', host: hosts[0] ?? '', autoDeploy: false },
    resolver: zodResolver(createStackFormSchema),
  });
  const { reset, setValue, getValues } = form;
  const values = form.watch();
  const { errors, touchedFields } = form.formState;

  // The taken name is remembered rather than set as a form error, which the form would keep until the field is next left.
  const [seenError, setSeenError] = useState(error);
  const [takenName, setTakenName] = useState<string | null>(null);
  if (error !== seenError) {
    setSeenError(error);
    setTakenName(error?.field === 'stackName' ? getValues('stackName').trim() : null);
  }
  const takenMessage = takenName !== null && takenName === values.stackName.trim() ? error?.message : undefined;
  const nameError = errors.stackName?.message ?? takenMessage;

  const check = createStackFormSchema.safeParse(values);
  const isValid = check.success && !nameError;
  const reason = hosts.length === 0 ? NO_HOSTS_REASON : blockedReason(fieldIssues(check), {
    isTouched: (field) => Boolean(touchedFields[field as keyof CreateStackInput]),
    isEmpty: (field) => String(values[field as keyof CreateStackInput]).trim() === '',
  });

  useEffect(() => {
    if (open) reset({ stackName: '', host: hosts[0] ?? '', autoDeploy: false });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reconcile host selection when the available hosts list changes (e.g., background refresh)
  useEffect(() => {
    if (!open) return;
    if (!hosts.includes(getValues('host'))) setValue('host', hosts[0] ?? '');
  }, [open, hosts, getValues, setValue]);

  function handleClose() {
    reset({ stackName: '', host: hosts[0] ?? '', autoDeploy: false });
    onClose();
  }

  const handleSubmit = form.handleSubmit((input) => {
    if (isLoading) return;
    onSubmit(input);
  });

  return (
    <Dialog open={open} busy={isLoading} onOpenChange={(isOpen) => { if (!isOpen) handleClose(); }}>
      <DialogContent>
        <DialogTitle>Create Stack</DialogTitle>
        <DialogBody className="flex flex-col gap-4 pt-1">
          {error && error.field === null && (
            <Alert variant="error">
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          )}
          <Field id="stack-name" label="Stack Name" error={nameError} hint="e.g. my-app or my_stack">
            {(control) => <Input {...control} autoFocus disabled={isLoading} {...checkedOnFill(form.register('stackName'))} />}
          </Field>
          {hosts.length > 1 && (
            <div className="flex flex-col gap-1">
              <Label htmlFor="target-host" className="text-sm mb-1">Target Host</Label>
              <Select
                value={values.host}
                onValueChange={(value) => { if (value) setValue('host', value, { shouldDirty: true, shouldTouch: true, shouldValidate: true }); }}
                disabled={isLoading}
              >
                <SelectTrigger id="target-host">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {hosts.map((h) => (
                    <SelectItem key={h} value={h}>
                      {h}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <Label className="text-sm mb-1">Deploy Mode</Label>
            <RadioGroup
              value={values.autoDeploy ? 'auto' : 'manual'}
              onValueChange={(value) => setValue('autoDeploy', value === 'auto', { shouldDirty: true })}
              disabled={isLoading}
            >
              <Label className="flex items-center gap-3 cursor-pointer" htmlFor="deploy-auto">
                <RadioGroupItem id="deploy-auto" value="auto" />
                <span>
                  <span className="text-sm font-medium">Auto</span>
                  <span className="ml-2 text-xs opacity-70">Deploy on every git push</span>
                </span>
              </Label>
              <Label className="flex items-center gap-3 cursor-pointer" htmlFor="deploy-manual">
                <RadioGroupItem id="deploy-manual" value="manual" />
                <span>
                  <span className="text-sm font-medium">Manual</span>
                  <span className="ml-2 text-xs opacity-70">Deploy only when triggered manually</span>
                </span>
              </Label>
            </RadioGroup>
          </div>
        </DialogBody>
        <DialogFooter>
          {reason && <ActionReason className="mr-auto min-w-0 pl-4">{reason}</ActionReason>}
          <Button variant="ghost" className="shrink-0 text-foreground" onClick={handleClose}>
            Cancel
          </Button>
          <Button className="shrink-0" onClick={() => { void handleSubmit(); }} disabled={!isValid}>
            Create Stack
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

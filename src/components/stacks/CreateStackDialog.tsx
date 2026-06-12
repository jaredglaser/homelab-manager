import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const STACK_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

interface CreateStackInput {
  stackName: string;
  host: string;
  autoDeploy: boolean;
}

interface CreateStackDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: CreateStackInput) => void;
  hosts: string[];
  isLoading: boolean;
  error?: string | null;
}

export default function CreateStackDialog({
  open,
  onClose,
  onSubmit,
  hosts,
  isLoading,
  error,
}: CreateStackDialogProps) {
  const [stackName, setStackName] = useState('');
  const [host, setHost] = useState(hosts[0] ?? '');
  const [autoDeploy, setAutoDeploy] = useState(false);

  useEffect(() => {
    if (open) {
      setStackName('');
      setHost(hosts[0] ?? '');
      setAutoDeploy(false);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reconcile host selection when the available hosts list changes (e.g., background refresh)
  useEffect(() => {
    if (!open) return;
    if (hosts.length === 0) {
      setHost('');
    } else {
      setHost((current) => hosts.includes(current) ? current : hosts[0]);
    }
  }, [open, hosts]);

  const nameError =
    stackName.length > 0 && !STACK_NAME_REGEX.test(stackName)
      ? 'Must start with a letter and contain only letters, numbers, hyphens, and underscores.'
      : '';
  const isValid = stackName.length > 0 && STACK_NAME_REGEX.test(stackName) && host.length > 0;

  function handleClose() {
    setStackName('');
    setHost(hosts[0] ?? '');
    setAutoDeploy(false);
    onClose();
  }

  function handleSubmit() {
    if (!isValid || isLoading) return;
    onSubmit({ stackName, host, autoDeploy });
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) handleClose(); }}>
      <DialogContent>
        <DialogTitle>Create Stack</DialogTitle>
        <DialogBody className="flex flex-col gap-4 pt-1">
          {error && (
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-col gap-1">
            <Label htmlFor="stack-name">Stack Name</Label>
            <Input
              id="stack-name"
              value={stackName}
              onChange={(e) => setStackName(e.target.value)}
              aria-invalid={!!nameError}
              className={nameError ? 'border-destructive focus:border-destructive focus:ring-destructive' : ''}
              autoFocus
              disabled={isLoading}
            />
            <p className={`text-xs ${nameError ? 'text-destructive' : 'text-muted-foreground'}`}>
              {nameError || 'e.g. my-app or my_stack'}
            </p>
          </div>
          {hosts.length > 1 && (
            <div className="flex flex-col gap-1">
              <Label htmlFor="target-host" className="text-sm mb-1">Target Host</Label>
              <Select
                value={host}
                onValueChange={(value) => { if (value) setHost(value); }}
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
              value={autoDeploy ? 'auto' : 'manual'}
              onValueChange={(value) => setAutoDeploy(value === 'auto')}
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
          <Button variant="ghost" className="text-foreground" onClick={handleClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!isValid || isLoading}>
            Create Stack
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

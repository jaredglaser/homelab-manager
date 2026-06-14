import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';

type DeleteMode = 'unmanage' | 'teardown';

interface DeleteStackDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (teardown: boolean) => void;
  stackName: string;
  isLoading: boolean;
}

export default function DeleteStackDialog({
  open,
  onClose,
  onConfirm,
  stackName,
  isLoading,
}: Readonly<DeleteStackDialogProps>) {
  const [mode, setMode] = useState<DeleteMode | null>(null);

  useEffect(() => {
    if (!open) setMode(null);
  }, [open]);

  function handleClose() {
    setMode(null);
    onClose();
  }

  function handleConfirm() {
    if (mode === null) return;
    onConfirm(mode === 'teardown');
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) handleClose(); }}>
      <DialogContent>
        <DialogTitle>Delete {stackName}?</DialogTitle>
        <DialogBody>
          <RadioGroup
            value={mode ?? ''}
            onValueChange={(value) => setMode(value as DeleteMode)}
          >
            <Label className="flex items-start gap-3 cursor-pointer py-1" htmlFor="delete-unmanage">
              <RadioGroupItem id="delete-unmanage" value="unmanage" className="mt-0.5" />
              <span>
                <span className="block text-sm font-medium">Remove from management</span>
                <span className="block text-xs opacity-70">
                  Containers keep running. Removes from git repo only.
                </span>
              </span>
            </Label>
            <Label className="flex items-start gap-3 cursor-pointer py-1" htmlFor="delete-teardown">
              <RadioGroupItem id="delete-teardown" value="teardown" className="mt-0.5" />
              <span>
                <span className="block text-sm font-medium text-destructive">
                  Tear down &amp; remove
                </span>
                <span className="block text-xs opacity-70">
                  Stops containers, removes from git repo.
                </span>
              </span>
            </Label>
          </RadioGroup>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" className="text-foreground" onClick={handleClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={mode === null || isLoading}
          >
            Delete Stack
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

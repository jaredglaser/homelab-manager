import { useState } from 'react';
import { useFormContext } from 'react-hook-form';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Trash2 } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { deleteVariable } from '@/data/stacks/functions';
import { secretFieldName, type StackFormValues } from '@/components/stacks/stack-form';

interface VariableRowProps {
  stackName: string;
  varName: string;
  isReferenced: boolean;
  revealed: boolean;
  onDeleted: () => void;
}

/**
 * One secret row. The value is a field on the shared stack form (registered
 * uncontrolled), so it is always editable without a per-row reveal and its edit
 * state survives tab switches. Masking is driven by the panel-wide `revealed`
 * toggle; saving is the panel's single "Save changes" action. Only delete stays
 * per-row because whether a variable can be removed is per-variable.
 */
export default function VariableRow({ stackName, varName, isReferenced, revealed, onDeleted }: Readonly<VariableRowProps>) {
  const { register } = useFormContext<StackFormValues>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const deleteMutation = useMutation({
    mutationFn: () => deleteVariable({ data: { stackName, variableName: varName } }),
    onSuccess: () => {
      setDeleteOpen(false);
      setDeleteError(null);
      onDeleted();
    },
    onError: () => {
      setDeleteError('Failed to delete variable.');
    },
  });

  return (
    <>
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <code className="text-xs font-mono min-w-[100px] opacity-80 truncate">
            {varName}
          </code>
          <div className="relative flex-1 min-w-0">
            <Input
              type={revealed ? 'text' : 'password'}
              autoComplete="off"
              placeholder="No value set"
              className="h-11 pr-12 text-xs lg:h-9 lg:pr-10"
              aria-label={`${varName} value`}
              {...register(secretFieldName(varName))}
            />
            <div className="absolute inset-y-0 right-1 flex items-center">
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-foreground size-9 lg:size-8"
                onClick={() => { setDeleteError(null); setDeleteOpen(true); }}
                aria-label="Delete variable"
                disabled={isReferenced || deleteMutation.isPending}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          </div>
        </div>
        {isReferenced && (
          <p className="text-[11px] text-muted-foreground">
            Still referenced in the compose file, so it cannot be deleted.
          </p>
        )}
      </div>

      <Dialog open={deleteOpen} onOpenChange={(isOpen) => { if (!isOpen) setDeleteOpen(false); }}>
        <DialogContent className="w-auto min-w-75">
          <DialogTitle>Delete variable</DialogTitle>
          <DialogBody>
            <DialogDescription className="px-0">
              Delete variable <strong>{varName}</strong>? This cannot be undone.
            </DialogDescription>
            {deleteError && (
              <Alert variant="error" className="text-xs mt-2">
                <AlertDescription>{deleteError}</AlertDescription>
              </Alert>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button
              variant="ghost"
              className="text-destructive"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

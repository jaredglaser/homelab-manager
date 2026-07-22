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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
      <div className="flex items-center gap-2">
        <code className="text-xs font-mono min-w-[100px] opacity-80 truncate">
          {varName}
        </code>
        <div className="relative flex-1 min-w-0">
          <Input
            type={revealed ? 'text' : 'password'}
            autoComplete="off"
            placeholder="No value set"
            className="h-9 pr-10 text-xs"
            aria-label={`${varName} value`}
            {...register(secretFieldName(varName))}
          />
          <div className="absolute inset-y-0 right-1 flex items-center">
            <Tooltip disabled={!isReferenced}>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-foreground"
                    onClick={() => { setDeleteError(null); setDeleteOpen(true); }}
                    aria-label="Delete variable"
                    disabled={isReferenced || deleteMutation.isPending}
                  />
                }
              >
                <Trash2 size={14} />
              </TooltipTrigger>
              <TooltipContent>Variable still referenced in compose file</TooltipContent>
            </Tooltip>
          </div>
        </div>
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

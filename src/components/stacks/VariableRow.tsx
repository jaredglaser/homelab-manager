import { useState } from 'react';
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
import { Eye, EyeOff, Save, Trash2 } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { getVariableValue, setVariableValue, deleteVariable } from '@/data/stacks/functions';

interface VariableRowProps {
  stackName: string;
  varName: string;
  isReferenced: boolean;
  onDeleted: () => void;
}

export default function VariableRow({ stackName, varName, isReferenced, onDeleted }: Readonly<VariableRowProps>) {
  const [visible, setVisible] = useState(false);
  const [fieldValue, setFieldValue] = useState('');
  const [originalValue, setOriginalValue] = useState('');
  const [valueFetched, setValueFetched] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const fetchValueMutation = useMutation({
    mutationFn: () => getVariableValue({ data: { stackName, variableName: varName } }),
    onSuccess: (val) => {
      const v = val ?? '';
      setFieldValue(v);
      setOriginalValue(v);
      setValueFetched(true);
      setFetchError(null);
    },
    onError: () => {
      setFetchError('Failed to retrieve value.');
    },
  });

  const isDirty = valueFetched && fieldValue !== originalValue;

  const saveMutation = useMutation({
    mutationFn: () => {
      const valueToSave = fieldValue;
      return setVariableValue({ data: { stackName, variableName: varName, value: valueToSave } })
        .then(() => valueToSave);
    },
    onSuccess: (savedValue: string) => {
      setOriginalValue(savedValue);
      setSaveError(null);
    },
    onError: () => {
      setSaveError('Failed to save value.');
    },
  });

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

  function handleToggleVisibility() {
    const nextVisible = !visible;
    setVisible(nextVisible);
    if (nextVisible && !valueFetched) {
      setFetchError(null);
      fetchValueMutation.mutate();
    }
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <code className="text-xs font-mono min-w-[100px] opacity-80 truncate">
            {varName}
          </code>
          <div className="relative flex-1 min-w-0">
            <Input
              type={visible ? 'text' : 'password'}
              value={valueFetched ? fieldValue : ''}
              onChange={(e) => setFieldValue(e.target.value)}
              disabled={!valueFetched || fetchValueMutation.isPending}
              placeholder={fetchValueMutation.isPending ? 'Loading…' : 'Click eye to reveal'}
              className="h-9 pr-26 text-xs"
            />
            <div className="absolute inset-y-0 right-1 flex items-center">
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-foreground"
                onClick={handleToggleVisibility}
                aria-label={visible ? 'Hide value' : 'Reveal value'}
                disabled={fetchValueMutation.isPending}
              >
                {visible ? <EyeOff size={14} /> : <Eye size={14} />}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-foreground"
                onClick={() => { setSaveError(null); saveMutation.mutate(); }}
                aria-label="Save value"
                disabled={!isDirty || saveMutation.isPending}
              >
                <Save size={14} />
              </Button>
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
        {fetchError && (
          <Alert variant="error" className="text-xs py-1">
            <AlertDescription>{fetchError}</AlertDescription>
          </Alert>
        )}
        {saveError && (
          <Alert variant="error" className="text-xs py-1">
            <AlertDescription>{saveError}</AlertDescription>
          </Alert>
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

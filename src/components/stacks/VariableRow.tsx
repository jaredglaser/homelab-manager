import { useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  InputAdornment,
  TextField,
  Tooltip,
} from '@mui/material';
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
          <TextField
            size="small"
            type={visible ? 'text' : 'password'}
            value={valueFetched ? fieldValue : ''}
            onChange={(e) => setFieldValue(e.target.value)}
            disabled={!valueFetched || fetchValueMutation.isPending}
            fullWidth
            placeholder={fetchValueMutation.isPending ? 'Loading…' : 'Click eye to reveal'}
            slotProps={{
              input: {
                className: 'text-xs',
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      size="small"
                      onClick={handleToggleVisibility}
                      aria-label={visible ? 'Hide value' : 'Reveal value'}
                      disabled={fetchValueMutation.isPending}
                    >
                      {visible ? <EyeOff size={14} /> : <Eye size={14} />}
                    </IconButton>
                    <IconButton
                      size="small"
                      onClick={() => { setSaveError(null); saveMutation.mutate(); }}
                      aria-label="Save value"
                      disabled={!isDirty || saveMutation.isPending}
                    >
                      <Save size={14} />
                    </IconButton>
                    <Tooltip
                      title={isReferenced ? 'Variable still referenced in compose file' : ''}
                      disableHoverListener={!isReferenced}
                      disableFocusListener={!isReferenced}
                      disableTouchListener={!isReferenced}
                    >
                      <span>
                        <IconButton
                          size="small"
                          onClick={() => { setDeleteError(null); setDeleteOpen(true); }}
                          aria-label="Delete variable"
                          disabled={isReferenced || deleteMutation.isPending}
                        >
                          <Trash2 size={14} />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </InputAdornment>
                ),
              },
            }}
          />
        </div>
        {fetchError && (
          <Alert severity="error" className="text-xs py-0">
            {fetchError}
          </Alert>
        )}
        {saveError && (
          <Alert severity="error" className="text-xs py-0">
            {saveError}
          </Alert>
        )}
      </div>

      <Dialog open={deleteOpen} onClose={() => setDeleteOpen(false)}>
        <DialogTitle>Delete variable</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Delete variable <strong>{varName}</strong>? This cannot be undone.
          </DialogContentText>
          {deleteError && (
            <Alert severity="error" className="text-xs mt-2">
              {deleteError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteOpen(false)}>Cancel</Button>
          <Button
            color="error"
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

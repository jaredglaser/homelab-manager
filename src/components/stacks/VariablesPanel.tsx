import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Button,
  IconButton,
  InputAdornment,
  Paper,
  Skeleton,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { Eye, EyeOff, Key, Save, Trash2 } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getStackVariables,
  getVariableValue,
  setVariableValue,
  deleteVariable,
  ensureVariablesExist,
} from '@/data/stacks.functions';

interface VariablesPanelProps {
  stackName: string;
  composeVariables: string[];
}

interface VariableRowProps {
  stackName: string;
  varName: string;
  isReferenced: boolean;
  onDeleted: () => void;
}

function VariableRow({ stackName, varName, isReferenced, onDeleted }: Readonly<VariableRowProps>) {
  const [visible, setVisible] = useState(false);
  const [fieldValue, setFieldValue] = useState('');
  const [originalValue, setOriginalValue] = useState('');
  const [valueFetched, setValueFetched] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const fetchValueMutation = useMutation({
    mutationFn: () => getVariableValue({ data: { stackName, variableName: varName } }),
    onSuccess: (val) => {
      const v = val ?? '';
      setFieldValue(v);
      setOriginalValue(v);
      setValueFetched(true);
    },
  });

  const isDirty = valueFetched && fieldValue !== originalValue;

  const saveMutation = useMutation({
    mutationFn: () =>
      setVariableValue({ data: { stackName, variableName: varName, value: fieldValue } }),
    onSuccess: () => {
      setOriginalValue(fieldValue);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteVariable({ data: { stackName, variableName: varName } }),
    onSuccess: () => {
      setDeleteOpen(false);
      onDeleted();
    },
  });

  function handleToggleVisibility() {
    const nextVisible = !visible;
    setVisible(nextVisible);
    if (nextVisible && !valueFetched) {
      fetchValueMutation.mutate();
    }
  }

  return (
    <>
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
              className: '!text-xs',
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
                    onClick={() => saveMutation.mutate()}
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
                        onClick={() => setDeleteOpen(true)}
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

      <Dialog open={deleteOpen} onClose={() => setDeleteOpen(false)}>
        <DialogTitle>Delete variable</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Delete variable <strong>{varName}</strong> from OpenBao? This cannot be undone.
          </DialogContentText>
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

/**
 * Side panel showing variables stored in OpenBao for a stack.
 * Source of truth is OpenBao — compose file variables drive initial creation only.
 */
export default function VariablesPanel({ stackName, composeVariables }: Readonly<VariablesPanelProps>) {
  const queryClient = useQueryClient();
  const composeSet = new Set(composeVariables);

  const {
    data: variables,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['stack-variables', stackName],
    queryFn: () => getStackVariables({ data: { stackName } }),
  });

  // Auto-create compose variables missing from OpenBao (e.g., after OpenBao restart)
  const ensurePending = useRef(false);
  useEffect(() => {
    if (!variables || ensurePending.current) return;
    const existing = new Set(variables);
    const missing = composeVariables.filter((v) => !existing.has(v));
    if (missing.length === 0) return;

    ensurePending.current = true;
    ensureVariablesExist({ data: { stackName, variableNames: missing } })
      .then(() => queryClient.invalidateQueries({ queryKey: ['stack-variables', stackName] }))
      .catch(() => { /* OpenBao unreachable — error already shown by the query */ })
      .finally(() => { ensurePending.current = false; });
  }, [variables, composeVariables, stackName, queryClient]);

  function handleDeleted() {
    void queryClient.invalidateQueries({ queryKey: ['stack-variables', stackName] });
  }

  if (isError) {
    return (
      <Alert severity="error" className="text-xs">
        Unable to connect to OpenBao. Secret management is unavailable.
      </Alert>
    );
  }

  if (isLoading) {
    return (
      <Paper elevation={0} className="p-3 !bg-[var(--mui-palette-background-chartBg)] rounded-sm">
        <div className="space-y-2">
          <Skeleton variant="text" width="60%" />
          <Skeleton variant="rounded" height={36} />
          <Skeleton variant="rounded" height={36} />
          <Skeleton variant="rounded" height={36} />
        </div>
      </Paper>
    );
  }

  const variableList = variables ?? [];

  if (variableList.length === 0) {
    return (
      <Paper elevation={0} className="p-3 !bg-[var(--mui-palette-background-chartBg)] rounded-sm">
        <Typography variant="body2" className="opacity-50">
          No variables in OpenBao.
        </Typography>
      </Paper>
    );
  }

  return (
    <Paper elevation={0} className="p-3 !bg-[var(--mui-palette-background-chartBg)] rounded-sm">
      <div className="flex items-center gap-2 mb-3">
        <Key size={16} className="opacity-60" />
        <Typography variant="subtitle2">Variables</Typography>
        <Chip size="small" label={variableList.length} className="!text-xs !h-5" />
      </div>
      <div className="space-y-2">
        {variableList.map((varName) => (
          <VariableRow
            key={varName}
            stackName={stackName}
            varName={varName}
            isReferenced={composeSet.has(varName)}
            onDeleted={handleDeleted}
          />
        ))}
      </div>
    </Paper>
  );
}

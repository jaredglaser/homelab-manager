import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Alert,
  Chip,
  Paper,
  Skeleton,
  Typography,
} from '@mui/material';
import { Key } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getStackVariables, ensureVariablesExist } from '@/data/stacks/functions';
import VariableRow from '@/components/stacks/VariableRow';

interface VariablesPanelProps {
  stackName: string;
  composeVariables: string[];
}

/**
 * Side panel showing variables stored in OpenBao for a stack.
 * Source of truth is OpenBao; compose file variables drive initial creation only.
 */
export default function VariablesPanel({ stackName, composeVariables }: Readonly<VariablesPanelProps>) {
  const queryClient = useQueryClient();
  const composeSet = useMemo(() => new Set(composeVariables), [composeVariables]);

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
      .catch(() => { /* OpenBao unreachable, error already shown by the query */ })
      .finally(() => { ensurePending.current = false; });
  }, [variables, composeVariables, stackName, queryClient]);

  const handleDeleted = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['stack-variables', stackName] });
  }, [queryClient, stackName]);

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

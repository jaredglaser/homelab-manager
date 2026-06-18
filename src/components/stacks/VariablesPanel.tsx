import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Key } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getStackVariables, ensureVariablesExist } from '@/data/stacks/functions';
import VariableRow from '@/components/stacks/VariableRow';

interface VariablesPanelProps {
  stackName: string;
  composeVariables: string[];
}

/**
 * Side panel showing variables stored as encrypted secrets for a stack.
 * Source of truth is the encrypted secrets store; compose file variables drive initial creation only.
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

  // Auto-create compose variables missing from the secrets store (e.g., after the DB is reset)
  const ensurePending = useRef(false);
  useEffect(() => {
    if (!variables || ensurePending.current) return;
    const existing = new Set(variables);
    const missing = composeVariables.filter((v) => !existing.has(v));
    if (missing.length === 0) return;

    ensurePending.current = true;
    ensureVariablesExist({ data: { stackName, variableNames: missing } })
      .then(() => queryClient.invalidateQueries({ queryKey: ['stack-variables', stackName] }))
      .catch(() => { /* Secrets store unreachable, error already shown by the query */ })
      .finally(() => { ensurePending.current = false; });
  }, [variables, composeVariables, stackName, queryClient]);

  const handleDeleted = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['stack-variables', stackName] });
  }, [queryClient, stackName]);

  if (isError) {
    return (
      <Alert variant="error" className="text-xs">
        <AlertDescription>Unable to load secrets. Variable management is unavailable.</AlertDescription>
      </Alert>
    );
  }

  if (isLoading) {
    return (
      <div className="p-3 bg-chart-bg rounded-sm">
        <div className="space-y-2">
          <Skeleton className="h-4 w-3/5" />
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
        </div>
      </div>
    );
  }

  const variableList = variables ?? [];

  if (variableList.length === 0) {
    return (
      <div className="p-3 bg-chart-bg rounded-sm">
        <p className="text-sm opacity-50">No variables yet.</p>
      </div>
    );
  }

  return (
    <div className="p-3 bg-chart-bg rounded-sm">
      <div className="flex items-center gap-2 mb-3">
        <Key size={16} className="opacity-60" />
        <span className="text-sm font-medium">Variables</span>
        <Badge variant="secondary" className="text-xs h-5">{variableList.length}</Badge>
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
    </div>
  );
}

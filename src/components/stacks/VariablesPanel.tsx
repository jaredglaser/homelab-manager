import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFormContext, useFormState } from 'react-hook-form';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Eye, EyeOff, Key, Save } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getStackVariables, getVariableValue, setVariableValue, ensureVariablesExist } from '@/data/stacks/functions';
import { useToast } from '@/hooks/toastAtom';
import VariableRow from '@/components/stacks/VariableRow';
import { secretFieldName, type StackFormValues } from '@/components/stacks/stack-form';

interface VariablesPanelProps {
  stackName: string;
  composeVariables: string[];
}

const VARIABLE_VALUES_QUERY_KEY = 'stack-variable-values';

/**
 * Secrets panel. Loads every variable value up front so the whole tab has one
 * reveal toggle (masking only, no per-field fetch) and one "Save changes" that
 * commits all edited values at once. The values are held in the shared stack
 * form, so edits persist across tab switches and feed the unsaved-changes guard.
 */
export default function VariablesPanel({ stackName, composeVariables }: Readonly<VariablesPanelProps>) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const form = useFormContext<StackFormValues>();
  const composeSet = useMemo(() => new Set(composeVariables), [composeVariables]);
  const [revealed, setRevealed] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: [VARIABLE_VALUES_QUERY_KEY, stackName],
    queryFn: async (): Promise<Record<string, string>> => {
      const names = await getStackVariables({ data: { stackName } });
      const entries = await Promise.all(
        names.map(async (name) =>
          [name, (await getVariableValue({ data: { stackName, variableName: name } })) ?? ''] as const,
        ),
      );
      return Object.fromEntries(entries);
    },
  });

  // Auto-create compose variables missing from the secrets store (e.g., after the DB is reset)
  const ensurePending = useRef(false);
  useEffect(() => {
    if (!data || ensurePending.current) return;
    const existing = new Set(Object.keys(data));
    const missing = composeVariables.filter((v) => !existing.has(v));
    if (missing.length === 0) return;

    ensurePending.current = true;
    ensureVariablesExist({ data: { stackName, variableNames: missing } })
      .then(() => queryClient.invalidateQueries({ queryKey: [VARIABLE_VALUES_QUERY_KEY, stackName] }))
      .catch(() => { /* Secrets store unreachable, error already shown by the query */ })
      .finally(() => { ensurePending.current = false; });
  }, [data, composeVariables, stackName, queryClient]);

  // Seed each field's clean baseline from the stored value. Skip fields the user
  // has already edited so a blind overwrite typed before load is never clobbered.
  // `form` from useFormContext gets a fresh identity every render, so seed off
  // `data` only (via a ref) or the resetField calls would loop each render.
  const formRef = useRef(form);
  formRef.current = form;
  useEffect(() => {
    if (!data) return;
    const f = formRef.current;
    const dirty = f.formState.dirtyFields.secrets ?? {};
    for (const [name, value] of Object.entries(data)) {
      if (!dirty[name]) {
        f.resetField(secretFieldName(name), { defaultValue: value });
      }
    }
  }, [data]);

  const { dirtyFields } = useFormState({ control: form.control, name: 'secrets' });
  const dirtySecretNames = Object.entries(dirtyFields.secrets ?? {})
    .filter(([, isFieldDirty]) => isFieldDirty)
    .map(([name]) => name);
  const secretsDirty = dirtySecretNames.length > 0;

  const saveAll = useMutation({
    mutationFn: async (): Promise<string[]> => {
      await Promise.all(
        dirtySecretNames.map((name) =>
          setVariableValue({ data: { stackName, variableName: name, value: form.getValues(secretFieldName(name)) } }),
        ),
      );
      return dirtySecretNames;
    },
    onSuccess: (savedNames) => {
      const updated: Record<string, string> = {};
      savedNames.forEach((name) => {
        const value = form.getValues(secretFieldName(name));
        updated[name] = value;
        form.resetField(secretFieldName(name), { defaultValue: value });
      });
      queryClient.setQueryData<Record<string, string>>(
        [VARIABLE_VALUES_QUERY_KEY, stackName],
        (old) => ({ ...(old ?? {}), ...updated }),
      );
      showToast('Secrets saved', 'success');
    },
    onError: (err) => {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    },
  });

  const handleDeleted = useCallback((name: string) => {
    form.unregister(secretFieldName(name));
    queryClient.invalidateQueries({ queryKey: [VARIABLE_VALUES_QUERY_KEY, stackName] });
  }, [form, queryClient, stackName]);

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

  const variableNames = data ? Object.keys(data) : [];

  if (variableNames.length === 0) {
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
        <Badge variant="secondary" className="text-xs h-5">{variableNames.length}</Badge>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="text-foreground"
          onClick={() => setRevealed((r) => !r)}
          aria-label={revealed ? 'Hide all values' : 'Reveal all values'}
        >
          {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
          {revealed ? 'Hide' : 'Reveal'}
        </Button>
        <Button
          size="sm"
          onClick={() => saveAll.mutate()}
          disabled={!secretsDirty || saveAll.isPending}
          className="normal-case"
        >
          {saveAll.isPending ? <Spinner className="size-3.5" /> : <Save size={14} />}
          Save changes
        </Button>
      </div>
      <div className="space-y-2">
        {variableNames.map((name) => (
          <VariableRow
            key={name}
            stackName={stackName}
            varName={name}
            isReferenced={composeSet.has(name)}
            revealed={revealed}
            onDeleted={() => handleDeleted(name)}
          />
        ))}
      </div>
    </div>
  );
}

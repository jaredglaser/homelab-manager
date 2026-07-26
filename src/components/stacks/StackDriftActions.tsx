import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import StackDriftResolveDialog from '@/components/stacks/StackDriftResolveDialog';
import type { StackDriftItem, StackDriftResolution } from '@/types/stacks';
import {
  getAllowedStackDriftResolutions,
  getStackDriftResolutionLabel,
  isDestructiveStackDriftResolution,
} from '@/lib/stacks/stack-drift-service';
import { formatDriftResolutionOutcome } from '@/lib/stacks/deploy-outcome-toast';
import { resolveDrift } from '@/data/stacks/functions';
import { STACKS_QUERY_KEY, STACK_DRIFT_QUERY_KEY } from '@/lib/constants/stacks-keys';
import { useToast } from '@/hooks/toastAtom';

interface StackDriftActionsProps {
  item: StackDriftItem;
}

export default function StackDriftActions({ item }: Readonly<StackDriftActionsProps>) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [pendingResolution, setPendingResolution] = useState<StackDriftResolution | null>(null);

  const mutation = useMutation({
    mutationFn: (resolution: StackDriftResolution) =>
      resolveDrift({ data: { host: item.host, stack: item.stack, kind: item.kind, resolution } }),
    onSuccess: (result) => {
      setPendingResolution(null);
      queryClient.invalidateQueries({ queryKey: STACK_DRIFT_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: STACKS_QUERY_KEY });
      const { message, severity } = formatDriftResolutionOutcome(`${item.host}/${item.stack}`, result);
      showToast(message, severity);
    },
    onError: (err) => {
      setPendingResolution(null);
      showToast(err instanceof Error ? err.message : String(err), 'error');
    },
  });

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {getAllowedStackDriftResolutions(item.kind).map((resolution) => (
          <Button
            key={resolution}
            size="sm"
            variant={isDestructiveStackDriftResolution(item.kind, resolution) ? 'destructive' : 'outline'}
            disabled={mutation.isPending}
            onClick={() => setPendingResolution(resolution)}
          >
            {mutation.isPending && mutation.variables === resolution && <Spinner className="size-3.5" />}
            {getStackDriftResolutionLabel(item.kind, resolution)}
          </Button>
        ))}
      </div>

      {pendingResolution && (
        <StackDriftResolveDialog
          open
          item={item}
          resolution={pendingResolution}
          isLoading={mutation.isPending}
          onClose={() => setPendingResolution(null)}
          onConfirm={() => mutation.mutate(pendingResolution)}
        />
      )}
    </>
  );
}

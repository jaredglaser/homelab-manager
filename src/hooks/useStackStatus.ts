import { useCallback, useState } from 'react';
import { useMuxQuery } from '@/lib/mux/use-mux-channel';
import { STACK_STATUS_TOPIC } from '@/lib/mux/protocol';
import { stackStatusChannel, type StackSSEMessage } from '@/lib/sse/channels/stack-status';
import { useToast } from '@/hooks/toastAtom';
import { deployToastGate, formatDeployOutcome } from '@/lib/stacks/deploy-outcome-toast';
import type { StackStatusEntry } from '@/types/stacks';

type DeployChangedMessage = Extract<StackSSEMessage, { type: 'deploy_changed' }>;

function isDeployChanged(data: StackSSEMessage): data is DeployChangedMessage {
  return !Array.isArray(data) && 'type' in data && data.type === 'deploy_changed';
}

function shallowEqualContainers(
  prev: StackStatusEntry | undefined,
  next: StackStatusEntry,
): boolean {
  if (!prev) return false;
  if (prev.containers.length !== next.containers.length) return false;
  for (let i = 0; i < prev.containers.length; i++) {
    const a = prev.containers[i];
    const b = next.containers[i];
    if (a.id !== b.id || a.status !== b.status || a.name !== b.name || a.image !== b.image) {
      return false;
    }
  }
  return true;
}

/**
 * Entry arrays merge into the map keyed by host/stack (same semantics as the old SSE
 * reducer: an unchanged entry keeps the previous Map reference); a deploy_changed frame
 * carries no entry data and leaves the map untouched.
 */
export function foldStackStatus(
  prev: Map<string, StackStatusEntry>,
  data: StackSSEMessage,
): Map<string, StackStatusEntry> {
  if (isDeployChanged(data)) return prev;
  let changed = false;
  const next = new Map(prev);
  for (const e of data) {
    const key = `${e.host}/${e.stack}`;
    if (!shallowEqualContainers(prev.get(key), e)) {
      next.set(key, e);
      changed = true;
    }
  }
  return changed ? next : prev;
}

const EMPTY_STATUS_MAP = new Map<string, StackStatusEntry>();

export function useStackStatus() {
  const [deployVersion, setDeployVersion] = useState(0);
  const { showToast } = useToast();

  const handleDeployChanged = useCallback((data: StackSSEMessage) => {
    if (!isDeployChanged(data)) return;
    setDeployVersion((v) => v + 1);
    if (data.outcome !== undefined) {
      const outcome = formatDeployOutcome({ host: data.host, stack: data.stack, ...data.outcome });
      // Gate only when there is a toast to show; a non-terminal frame must not
      // consume the deployId's one-shot gate and suppress the later terminal toast.
      if (outcome && deployToastGate.shouldToast(data.outcome.deployId)) {
        showToast(outcome.message, outcome.severity);
      }
    }
  }, [showToast]);

  const { state: statusMap, isConnected, error } = useMuxQuery(
    { ...stackStatusChannel, topic: STACK_STATUS_TOPIC },
    {
      queryKey: ['stack-status'],
      initial: EMPTY_STATUS_MAP,
      fold: foldStackStatus,
      onData: handleDeployChanged,
      serviceErrorMessage: 'Stack status stream unavailable',
    },
  );

  return { statusMap, isConnected, error: error?.message ?? null, deployVersion };
}

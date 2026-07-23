import { useCallback, useState } from 'react';
import { useSseChannel } from '@/hooks/useSseChannel';
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

export function useStackStatus() {
  const [statusMap, setStatusMap] = useState<Map<string, StackStatusEntry>>(new Map());
  const [deployVersion, setDeployVersion] = useState(0);
  const { showToast } = useToast();

  const handleData = useCallback((data: StackSSEMessage) => {
    if (isDeployChanged(data)) {
      setDeployVersion((v) => v + 1);
      if (
        data.deployId !== undefined &&
        data.status !== undefined &&
        data.action !== undefined &&
        data.trigger !== undefined &&
        deployToastGate.shouldToast(data.deployId)
      ) {
        const outcome = formatDeployOutcome({
          stack: data.stack,
          action: data.action,
          status: data.status,
          trigger: data.trigger,
          message: data.message,
        });
        if (outcome) showToast(outcome.message, outcome.severity);
      }
      return;
    }

    setStatusMap((prev) => {
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
    });
  }, [showToast]);

  const { isConnected, error } = useSseChannel(stackStatusChannel, {
    onData: handleData,
    serviceErrorMessage: 'Stack status stream unavailable',
  });

  return { statusMap, isConnected, error: error?.message ?? null, deployVersion };
}

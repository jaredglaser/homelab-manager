import { useCallback, useState } from 'react';
import { apiUrl } from '@/lib/utils/api-url';
import type { StackStatusEntry } from '@/types/stacks';
import { useEventSource } from '@/hooks/useEventSource';

type StackSSEMessage =
  | StackStatusEntry[]
  | { type: 'deploy_changed'; stack: string; host: string };

function isDeployChanged(data: StackSSEMessage): data is { type: 'deploy_changed'; stack: string; host: string } {
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

  const handleData = useCallback((data: StackSSEMessage) => {
    if (isDeployChanged(data)) {
      setDeployVersion((v) => v + 1);
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
  }, []);

  const { isConnected, error } = useEventSource<StackSSEMessage>({
    url: apiUrl('/api/stack-status'),
    onData: handleData,
  });

  return { statusMap, isConnected, error: error?.message ?? null, deployVersion };
}

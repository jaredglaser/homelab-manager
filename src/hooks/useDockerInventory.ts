import { useCallback, useState } from 'react';
import { apiUrl } from '@/lib/utils/api-url';
import type {
  DockerInventorySnapshotContainer,
  DockerInventoryBroadcastEvent,
  DockerInventoryUpdateContainer,
} from '@/types/docker-inventory';
import { useEventSource } from '@/hooks/useEventSource';

export interface UseDockerInventoryResult {
  inventory: Map<string, DockerInventorySnapshotContainer>;
  isConnected: boolean;
  error: Error | null;
}

/**
 * Merge an upsert (labels-less) into the existing entry's labels (if present),
 * or fall back to an empty label map for brand-new containers. An upsert for
 * a container that exists in `init` preserves its labels; an upsert for one
 * not yet seen leaves labels empty until the next init / snapshot fetch.
 */
function mergeUpsert(
  prev: DockerInventorySnapshotContainer | undefined,
  update: DockerInventoryUpdateContainer,
): DockerInventorySnapshotContainer {
  return { ...update, labels: prev?.labels ?? {} };
}

export function useDockerInventory(): UseDockerInventoryResult {
  const [inventory, setInventory] = useState<Map<string, DockerInventorySnapshotContainer>>(new Map());
  const [serviceError, setServiceError] = useState<Error | null>(null);

  const handleData = useCallback((event: DockerInventoryBroadcastEvent) => {
    setServiceError(null);
    if (event.type === 'init') {
      const next = new Map<string, DockerInventorySnapshotContainer>();
      for (const container of event.containers) {
        next.set(`${container.host}/${container.containerId}`, container);
      }
      setInventory(next);
    } else if (event.type === 'upsert') {
      const { container } = event;
      setInventory((prev) => {
        const next = new Map(prev);
        const key = `${container.host}/${container.containerId}`;
        next.set(key, mergeUpsert(prev.get(key), container));
        return next;
      });
    } else if (event.type === 'destroy') {
      const key = `${event.host}/${event.containerId}`;
      setInventory((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
    }
  }, []);

  const handleServiceError = useCallback(() => {
    setServiceError(new Error('Inventory stream unavailable'));
  }, []);

  const { isConnected, error } = useEventSource<DockerInventoryBroadcastEvent>({
    url: apiUrl('/api/docker-inventory'),
    onData: handleData,
    onServiceError: handleServiceError,
    errorEventName: 'inventory_error',
  });

  return { inventory, isConnected, error: error ?? serviceError };
}

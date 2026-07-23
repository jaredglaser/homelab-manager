import { useCallback, useState } from 'react';
import { useSseChannel } from '@/hooks/useSseChannel';
import { dockerInventoryChannel } from '@/lib/sse/channels/docker-inventory';
import type {
  DockerInventorySnapshotContainer,
  DockerInventoryBroadcastEvent,
  DockerInventoryUpdateContainer,
} from '@/types/docker-inventory';

export interface UseDockerInventoryResult {
  inventory: Map<string, DockerInventorySnapshotContainer>;
  isConnected: boolean;
  error: Error | null;
}

/** Upsert frames omit labels; preserve the existing entry's labels, or empty for a container not yet seen. */
function mergeUpsert(
  prev: DockerInventorySnapshotContainer | undefined,
  update: DockerInventoryUpdateContainer,
): DockerInventorySnapshotContainer {
  return { ...update, labels: prev?.labels ?? {} };
}

export function useDockerInventory(): UseDockerInventoryResult {
  const [inventory, setInventory] = useState<Map<string, DockerInventorySnapshotContainer>>(new Map());

  const handleData = useCallback((event: DockerInventoryBroadcastEvent) => {
    if (event.type === 'init') {
      const next = new Map<string, DockerInventorySnapshotContainer>();
      for (const container of event.containers) {
        next.set(`${container.host}/${container.containerId}`, container);
      }
      setInventory(next);
    } else if (event.type === 'upsert') {
      const container = event.container;
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

  const { isConnected, error } = useSseChannel(dockerInventoryChannel, {
    onData: handleData,
    serviceErrorMessage: 'Inventory stream unavailable',
  });

  return { inventory, isConnected, error };
}

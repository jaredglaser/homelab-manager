import { useCallback, useState } from 'react';
import { apiUrl } from '@/lib/utils/api-url';
import type { DockerContainerInventory, DockerInventoryBroadcastEvent } from '@/types/docker-inventory';
import { useEventSource } from '@/hooks/useEventSource';

export interface UseDockerInventoryResult {
  inventory: Map<string, DockerContainerInventory>;
  isConnected: boolean;
  error: Error | null;
}

export function useDockerInventory(): UseDockerInventoryResult {
  const [inventory, setInventory] = useState<Map<string, DockerContainerInventory>>(new Map());

  const handleData = useCallback((event: DockerInventoryBroadcastEvent) => {
    if (event.type === 'init') {
      const next = new Map<string, DockerContainerInventory>();
      for (const container of event.containers) {
        next.set(`${container.host}/${container.containerId}`, container);
      }
      setInventory(next);
    } else if (event.type === 'upsert') {
      const { container } = event;
      setInventory((prev) => {
        const next = new Map(prev);
        next.set(`${container.host}/${container.containerId}`, container);
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

  const { isConnected, error } = useEventSource<DockerInventoryBroadcastEvent>({
    url: apiUrl('/api/docker-inventory'),
    onData: handleData,
  });

  return { inventory, isConnected, error };
}

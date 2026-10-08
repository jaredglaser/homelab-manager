import { useMuxQuery } from '@/lib/mux/use-mux-channel';
import { INVENTORY_TOPIC } from '@/lib/mux/protocol';
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

/**
 * Upsert frames omit labels and mounts; preserve the existing entry's values, or empty for a
 * container not yet seen. Ports are carried on the upsert frame itself, but the field is
 * absent (not []) when the trigger dropped it for an oversized payload or an older server
 * omitted it, so falling back to the previous entry's ports avoids clobbering real data.
 */
export function mergeUpsert(
  prev: DockerInventorySnapshotContainer | undefined,
  update: DockerInventoryUpdateContainer,
): DockerInventorySnapshotContainer {
  return {
    ...update,
    labels: prev?.labels ?? {},
    ports: update.ports ?? prev?.ports ?? [],
    mounts: prev?.mounts ?? [],
  };
}

export function foldInventory(
  prev: Map<string, DockerInventorySnapshotContainer>,
  event: DockerInventoryBroadcastEvent,
): Map<string, DockerInventorySnapshotContainer> {
  if (event.type === 'init') {
    const next = new Map<string, DockerInventorySnapshotContainer>();
    for (const container of event.containers) {
      next.set(`${container.host}/${container.containerId}`, container);
    }
    return next;
  }
  if (event.type === 'upsert') {
    const container = event.container;
    const next = new Map(prev);
    const key = `${container.host}/${container.containerId}`;
    next.set(key, mergeUpsert(prev.get(key), container));
    return next;
  }
  const key = `${event.host}/${event.containerId}`;
  if (!prev.has(key)) return prev;
  const next = new Map(prev);
  next.delete(key);
  return next;
}

const EMPTY_INVENTORY = new Map<string, DockerInventorySnapshotContainer>();

export function useDockerInventory(): UseDockerInventoryResult {
  const { state, isConnected, error } = useMuxQuery(
    { ...dockerInventoryChannel, topic: INVENTORY_TOPIC },
    {
      queryKey: ['docker-inventory'],
      initial: EMPTY_INVENTORY,
      fold: foldInventory,
      serviceErrorMessage: 'Inventory stream unavailable',
    },
  );

  return { inventory: state, isConnected, error };
}

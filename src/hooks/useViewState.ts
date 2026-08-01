import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getViewState, setViewState } from '@/data/settings/functions';
import { SETTINGS_KEYS, type ViewStateKey } from '@/lib/constants/settings-keys';

export function parseExpandedSet(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((h): h is string => typeof h === 'string'));
    }
  } catch (err) {
    console.error('Failed to parse expanded set from view state:', err);
  }
  return new Set();
}

export const VIEW_STATE_QUERY_KEY = ['view-state'] as const;

export type ViewStateMap = Record<string, string>;

/**
 * Seeded by the route loaders. The client is the only writer, so the cached
 * value never goes stale within a session and nothing refetches it.
 */
export const viewStateQueryOptions = {
  queryKey: VIEW_STATE_QUERY_KEY,
  queryFn: () => getViewState(),
  staleTime: Infinity,
} as const;

export type ViewStateSetter = (
  key: ViewStateKey,
  computeValue: (prev: string | undefined) => string,
) => void;

export interface ViewStateAccess {
  viewState: ViewStateMap;
  setViewStateKey: ViewStateSetter;
}

/**
 * Row expansion and per-container shell choice, held in the query cache.
 *
 * Writes land in the cache first and persist in the background: a failed write
 * costs one collapsed row on the next reload, which is not worth a rollback or
 * a toast, and the DB has nothing to tell us that we did not just write.
 */
export function useViewState(): ViewStateAccess {
  const queryClient = useQueryClient();
  const { data } = useQuery(viewStateQueryOptions);

  const setViewStateKey = useCallback<ViewStateSetter>((key, computeValue) => {
    let newValue = '';
    queryClient.setQueryData<ViewStateMap>(VIEW_STATE_QUERY_KEY, (prev) => {
      newValue = computeValue(prev?.[key]);
      return { ...prev, [key]: newValue };
    });

    // createServerFn throws synchronously outside a request context, which a
    // bare .catch() would let escape into the click handler.
    Promise.resolve()
      .then(() => setViewState({ data: { key, value: newValue } }))
      .catch((err: unknown) => {
        console.error(`Failed to persist view state "${key}":`, err);
      });
  }, [queryClient]);

  return useMemo(() => ({ viewState: data ?? {}, setViewStateKey }), [data, setViewStateKey]);
}

/** Toggle-in-set helper: parses the JSON-encoded string, flips `item` membership, re-encodes. */
export function toggleInSet(raw: string | undefined, item: string): string {
  const set = parseExpandedSet(raw);
  if (set.has(item)) {
    set.delete(item);
  } else {
    set.add(item);
  }
  return JSON.stringify(Array.from(set));
}

export interface DockerViewState {
  toggleHostExpanded: (hostName: string) => void;
  isHostExpanded: (hostName: string, totalHosts: number) => boolean;
  toggleContainerExpanded: (containerId: string) => void;
  isContainerExpanded: (containerId: string) => boolean;
  toggleStackExpanded: (stackEntityId: string) => void;
  isStackExpanded: (stackEntityId: string) => boolean;
  setContainerShell: (containerKey: string, shell: string) => void;
  getContainerShell: (containerKey: string) => string | undefined;
}

function parseShells(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') result[k] = v;
    }
    return result;
  } catch {
    return {};
  }
}

export function useDockerViewState(): DockerViewState {
  const { viewState, setViewStateKey } = useViewState();

  const expandedHosts = useMemo(
    () => parseExpandedSet(viewState[SETTINGS_KEYS.docker.expandedHosts]),
    [viewState],
  );
  const expandedContainers = useMemo(
    () => parseExpandedSet(viewState[SETTINGS_KEYS.docker.expandedContainers]),
    [viewState],
  );
  const expandedStacks = useMemo(
    () => parseExpandedSet(viewState[SETTINGS_KEYS.stacks.expandedStacks]),
    [viewState],
  );
  const containerShells = useMemo(
    () => parseShells(viewState[SETTINGS_KEYS.docker.containerShells]),
    [viewState],
  );

  const toggleHostExpanded = useCallback((hostName: string) => {
    setViewStateKey(SETTINGS_KEYS.docker.expandedHosts, prev => toggleInSet(prev, hostName));
  }, [setViewStateKey]);

  // The docker key stores collapsed hosts, unlike every other expansion set.
  const isHostExpanded = useCallback(
    (hostName: string, totalHosts: number): boolean =>
      totalHosts === 1 || !expandedHosts.has(hostName),
    [expandedHosts],
  );

  const toggleContainerExpanded = useCallback((containerId: string) => {
    setViewStateKey(SETTINGS_KEYS.docker.expandedContainers, prev => toggleInSet(prev, containerId));
  }, [setViewStateKey]);

  const isContainerExpanded = useCallback(
    (containerId: string): boolean => expandedContainers.has(containerId),
    [expandedContainers],
  );

  const toggleStackExpanded = useCallback((stackEntityId: string) => {
    setViewStateKey(SETTINGS_KEYS.stacks.expandedStacks, prev => toggleInSet(prev, stackEntityId));
  }, [setViewStateKey]);

  const isStackExpanded = useCallback(
    (stackEntityId: string): boolean => expandedStacks.has(stackEntityId),
    [expandedStacks],
  );

  const setContainerShell = useCallback((containerKey: string, shell: string) => {
    setViewStateKey(SETTINGS_KEYS.docker.containerShells, prev =>
      JSON.stringify({ ...parseShells(prev), [containerKey]: shell }));
  }, [setViewStateKey]);

  const getContainerShell = useCallback(
    (containerKey: string): string | undefined => containerShells[containerKey],
    [containerShells],
  );

  return useMemo(() => ({
    toggleHostExpanded,
    isHostExpanded,
    toggleContainerExpanded,
    isContainerExpanded,
    toggleStackExpanded,
    isStackExpanded,
    setContainerShell,
    getContainerShell,
  }), [
    toggleHostExpanded,
    isHostExpanded,
    toggleContainerExpanded,
    isContainerExpanded,
    toggleStackExpanded,
    isStackExpanded,
    setContainerShell,
    getContainerShell,
  ]);
}

export interface ZfsViewState {
  toggleZfsHostExpanded: (hostName: string) => void;
  isZfsHostExpanded: (hostName: string, totalHosts: number) => boolean;
  togglePoolExpanded: (poolId: string) => void;
  isPoolExpanded: (poolId: string, totalPools: number) => boolean;
  toggleVdevExpanded: (vdevId: string) => void;
  isVdevExpanded: (vdevId: string) => boolean;
}

export function useZfsViewState(): ZfsViewState {
  const { viewState, setViewStateKey } = useViewState();

  const expandedHosts = useMemo(
    () => parseExpandedSet(viewState[SETTINGS_KEYS.zfs.expandedHosts]),
    [viewState],
  );
  const expandedPools = useMemo(
    () => parseExpandedSet(viewState[SETTINGS_KEYS.zfs.expandedPools]),
    [viewState],
  );
  const expandedVdevs = useMemo(
    () => parseExpandedSet(viewState[SETTINGS_KEYS.zfs.expandedVdevs]),
    [viewState],
  );

  const toggleZfsHostExpanded = useCallback((hostName: string) => {
    setViewStateKey(SETTINGS_KEYS.zfs.expandedHosts, prev => toggleInSet(prev, hostName));
  }, [setViewStateKey]);

  const isZfsHostExpanded = useCallback(
    (hostName: string, totalHosts: number): boolean =>
      totalHosts === 1 || expandedHosts.has(hostName),
    [expandedHosts],
  );

  const togglePoolExpanded = useCallback((poolId: string) => {
    setViewStateKey(SETTINGS_KEYS.zfs.expandedPools, prev => toggleInSet(prev, poolId));
  }, [setViewStateKey]);

  const isPoolExpanded = useCallback(
    (poolId: string, totalPools: number): boolean =>
      totalPools === 1 || expandedPools.has(poolId),
    [expandedPools],
  );

  const toggleVdevExpanded = useCallback((vdevId: string) => {
    setViewStateKey(SETTINGS_KEYS.zfs.expandedVdevs, prev => toggleInSet(prev, vdevId));
  }, [setViewStateKey]);

  const isVdevExpanded = useCallback(
    (vdevId: string): boolean => expandedVdevs.has(vdevId),
    [expandedVdevs],
  );

  return useMemo(() => ({
    toggleZfsHostExpanded,
    isZfsHostExpanded,
    togglePoolExpanded,
    isPoolExpanded,
    toggleVdevExpanded,
    isVdevExpanded,
  }), [
    toggleZfsHostExpanded,
    isZfsHostExpanded,
    togglePoolExpanded,
    isPoolExpanded,
    toggleVdevExpanded,
    isVdevExpanded,
  ]);
}

export interface ProxmoxViewState {
  toggleProxmoxHostExpanded: (node: string) => void;
  isProxmoxHostExpanded: (node: string) => boolean;
  toggleProxmoxSectionExpanded: (key: string) => void;
  isProxmoxSectionExpanded: (key: string) => boolean;
}

export function useProxmoxViewState(): ProxmoxViewState {
  const { viewState, setViewStateKey } = useViewState();

  const expandedHosts = useMemo(
    () => parseExpandedSet(viewState[SETTINGS_KEYS.proxmox.expandedHosts]),
    [viewState],
  );
  const expandedSections = useMemo(
    () => parseExpandedSet(viewState[SETTINGS_KEYS.proxmox.expandedSections]),
    [viewState],
  );

  const toggleProxmoxHostExpanded = useCallback((node: string) => {
    setViewStateKey(SETTINGS_KEYS.proxmox.expandedHosts, prev => toggleInSet(prev, node));
  }, [setViewStateKey]);

  // Both proxmox sets store the *collapsed* entries (absence = expanded), so
  // "no saved state" is not indistinguishable from "everything collapsed".
  const isProxmoxHostExpanded = useCallback(
    (node: string): boolean => !expandedHosts.has(node),
    [expandedHosts],
  );

  const toggleProxmoxSectionExpanded = useCallback((key: string) => {
    setViewStateKey(SETTINGS_KEYS.proxmox.expandedSections, prev => toggleInSet(prev, key));
  }, [setViewStateKey]);

  const isProxmoxSectionExpanded = useCallback(
    (key: string): boolean => !expandedSections.has(key),
    [expandedSections],
  );

  return useMemo(() => ({
    toggleProxmoxHostExpanded,
    isProxmoxHostExpanded,
    toggleProxmoxSectionExpanded,
    isProxmoxSectionExpanded,
  }), [
    toggleProxmoxHostExpanded,
    isProxmoxHostExpanded,
    toggleProxmoxSectionExpanded,
    isProxmoxSectionExpanded,
  ]);
}

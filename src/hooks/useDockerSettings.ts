import { useCallback, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import {
  dockerSettingsAtom,
  stacksSettingsAtom,
  type Settings,
  type MemoryDisplayMode,
  type DecimalSettings,
} from '@/hooks/settingsAtom';
import { useOptimisticSetting, toggleInSet } from '@/hooks/useOptimisticSetting';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';

export interface DockerSettingsValue {
  docker: Settings['docker'];
  stacks: Settings['stacks'];
  setMemoryDisplayMode: (mode: MemoryDisplayMode) => void;
  setChartWindowSeconds: (seconds: number) => void;
  setDockerDecimal: (key: keyof DecimalSettings, value: boolean) => void;
  toggleHostExpanded: (hostName: string) => void;
  isHostExpanded: (hostName: string, totalHosts: number) => boolean;
  toggleContainerExpanded: (containerId: string) => void;
  isContainerExpanded: (containerId: string) => boolean;
  toggleStackExpanded: (stackEntityId: string) => void;
  isStackExpanded: (stackEntityId: string) => boolean;
}

/**
 * Docker-dashboard settings: memory display, decimals, chart window, and host
 * / container / stack expansion state. Subscribes only to the docker and
 * stacks slices: ZFS/Proxmox/General changes do not re-render consumers.
 */
export function useDockerSettings(): DockerSettingsValue {
  const docker = useAtomValue(dockerSettingsAtom);
  const stacks = useAtomValue(stacksSettingsAtom);
  const optimisticSet = useOptimisticSetting();

  const setMemoryDisplayMode = useCallback((mode: MemoryDisplayMode) => {
    optimisticSet(SETTINGS_KEYS.docker.memoryDisplayMode, () => mode);
  }, [optimisticSet]);

  const setChartWindowSeconds = useCallback((seconds: number) => {
    optimisticSet(SETTINGS_KEYS.docker.chartWindowSeconds, () => String(seconds));
  }, [optimisticSet]);

  const setDockerDecimal = useCallback((key: keyof DecimalSettings, value: boolean) => {
    optimisticSet(SETTINGS_KEYS.docker.decimals[key], () => String(value));
  }, [optimisticSet]);

  const toggleHostExpanded = useCallback((hostName: string) => {
    optimisticSet(SETTINGS_KEYS.docker.expandedHosts, prev => toggleInSet(prev, hostName));
  }, [optimisticSet]);

  const isHostExpanded = useCallback(
    (hostName: string, totalHosts: number): boolean => {
      if (totalHosts === 1) return true;
      return !docker.expandedHosts.has(hostName);
    },
    [docker.expandedHosts],
  );

  const toggleContainerExpanded = useCallback((containerId: string) => {
    optimisticSet(SETTINGS_KEYS.docker.expandedContainers, prev => toggleInSet(prev, containerId));
  }, [optimisticSet]);

  const isContainerExpanded = useCallback(
    (containerId: string): boolean => docker.expandedContainers.has(containerId),
    [docker.expandedContainers],
  );

  const toggleStackExpanded = useCallback((stackEntityId: string) => {
    optimisticSet(SETTINGS_KEYS.stacks.expandedStacks, prev => toggleInSet(prev, stackEntityId));
  }, [optimisticSet]);

  const isStackExpanded = useCallback(
    (stackEntityId: string): boolean => stacks.expandedStacks.has(stackEntityId),
    [stacks.expandedStacks],
  );

  return useMemo<DockerSettingsValue>(() => ({
    docker,
    stacks,
    setMemoryDisplayMode,
    setChartWindowSeconds,
    setDockerDecimal,
    toggleHostExpanded,
    isHostExpanded,
    toggleContainerExpanded,
    isContainerExpanded,
    toggleStackExpanded,
    isStackExpanded,
  }), [
    docker,
    stacks,
    setMemoryDisplayMode,
    setChartWindowSeconds,
    setDockerDecimal,
    toggleHostExpanded,
    isHostExpanded,
    toggleContainerExpanded,
    isContainerExpanded,
    toggleStackExpanded,
    isStackExpanded,
  ]);
}

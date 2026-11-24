import { useCallback, useMemo } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import {
  dockerSettingsAtom,
  type Settings,
  type MemoryDisplayMode,
  type DecimalSettings,
} from '@/hooks/settingsAtom';
import {
  dockerCollapsedHostsAtom,
  dockerContainerShellsAtom,
  dockerExpandedContainersAtom,
  stacksExpandedAtom,
  toggledInSet,
} from '@/hooks/browserLayout';
import { useOptimisticSetting } from '@/hooks/useOptimisticSetting';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';

export interface DockerSettingsValue {
  docker: Settings['docker'];
  setMemoryDisplayMode: (mode: MemoryDisplayMode) => void;
  setChartWindowSeconds: (seconds: number) => void;
  setDockerDecimal: (key: keyof DecimalSettings, value: boolean) => void;
  toggleHostExpanded: (hostName: string) => void;
  isHostExpanded: (hostName: string, totalHosts: number) => boolean;
  toggleContainerExpanded: (containerId: string) => void;
  isContainerExpanded: (containerId: string) => boolean;
  toggleStackExpanded: (stackEntityId: string) => void;
  isStackExpanded: (stackEntityId: string) => boolean;
  setContainerShell: (containerKey: string, shell: string) => void;
  getContainerShell: (containerKey: string) => string | undefined;
}

/**
 * Docker-dashboard settings: memory display, decimals and chart window are global. Host / container / stack
 * expansion and the per-container shell are kept in this browser only.
 */
export function useDockerSettings(): DockerSettingsValue {
  const docker = useAtomValue(dockerSettingsAtom);
  const optimisticSet = useOptimisticSetting();
  const [collapsedHosts, setCollapsedHosts] = useAtom(dockerCollapsedHostsAtom);
  const [expandedContainers, setExpandedContainers] = useAtom(dockerExpandedContainersAtom);
  const [expandedStacks, setExpandedStacks] = useAtom(stacksExpandedAtom);
  const [containerShells, setContainerShells] = useAtom(dockerContainerShellsAtom);

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
    setCollapsedHosts(prev => toggledInSet(prev, hostName));
  }, [setCollapsedHosts]);

  const isHostExpanded = useCallback(
    (hostName: string, totalHosts: number): boolean => {
      if (totalHosts === 1) return true;
      return !collapsedHosts.has(hostName);
    },
    [collapsedHosts],
  );

  const toggleContainerExpanded = useCallback((containerId: string) => {
    setExpandedContainers(prev => toggledInSet(prev, containerId));
  }, [setExpandedContainers]);

  const isContainerExpanded = useCallback(
    (containerId: string): boolean => expandedContainers.has(containerId),
    [expandedContainers],
  );

  const toggleStackExpanded = useCallback((stackEntityId: string) => {
    setExpandedStacks(prev => toggledInSet(prev, stackEntityId));
  }, [setExpandedStacks]);

  const isStackExpanded = useCallback(
    (stackEntityId: string): boolean => expandedStacks.has(stackEntityId),
    [expandedStacks],
  );

  const setContainerShell = useCallback((containerKey: string, shell: string) => {
    setContainerShells(prev => ({ ...prev, [containerKey]: shell }));
  }, [setContainerShells]);

  const getContainerShell = useCallback(
    (containerKey: string): string | undefined => containerShells[containerKey],
    [containerShells],
  );

  return useMemo<DockerSettingsValue>(() => ({
    docker,
    setMemoryDisplayMode,
    setChartWindowSeconds,
    setDockerDecimal,
    toggleHostExpanded,
    isHostExpanded,
    toggleContainerExpanded,
    isContainerExpanded,
    toggleStackExpanded,
    isStackExpanded,
    setContainerShell,
    getContainerShell,
  }), [
    docker,
    setMemoryDisplayMode,
    setChartWindowSeconds,
    setDockerDecimal,
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

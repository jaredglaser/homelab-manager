import { useCallback, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import {
  dockerSettingsAtom,
  type Settings,
  type MemoryDisplayMode,
  type DecimalSettings,
} from '@/hooks/settingsAtom';
import { useOptimisticSetting } from '@/hooks/useOptimisticSetting';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';

export interface DockerSettingsValue {
  docker: Settings['docker'];
  setMemoryDisplayMode: (mode: MemoryDisplayMode) => void;
  setChartWindowSeconds: (seconds: number) => void;
  setDockerDecimal: (key: keyof DecimalSettings, value: boolean) => void;
}

/**
 * Docker-dashboard configuration: memory display, decimals, chart window.
 * Row expansion and shell choice live in `useDockerViewState`.
 */
export function useDockerSettings(): DockerSettingsValue {
  const docker = useAtomValue(dockerSettingsAtom);
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

  return useMemo<DockerSettingsValue>(() => ({
    docker,
    setMemoryDisplayMode,
    setChartWindowSeconds,
    setDockerDecimal,
  }), [docker, setMemoryDisplayMode, setChartWindowSeconds, setDockerDecimal]);
}

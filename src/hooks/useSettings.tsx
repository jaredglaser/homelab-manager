import { useCallback, useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  rawSettingsAtom,
  settingsAtom,
  parseExpandedSet,
  type Settings,
  type MemoryDisplayMode,
  type DecimalSettings,
  type ProxmoxUpdateInterval,
  type LightPalette,
} from './settingsAtom';
import { useToast } from './toastAtom';
import { updateSetting } from '@/data/settings.functions';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';

// Re-export types for backward-compatible imports
export type { Settings, MemoryDisplayMode, DecimalSettings, ProxmoxUpdateInterval, LightPalette } from './settingsAtom';

interface SettingsValue extends Settings {
  setUse12HourTime: (value: boolean) => void;
  setUpdateInterval: (value: number) => void;
  setMemoryDisplayMode: (mode: MemoryDisplayMode) => void;
  setShowSparklines: (value: boolean) => void;
  setUseAbbreviatedUnits: (value: boolean) => void;
  toggleHostExpanded: (hostName: string) => void;
  isHostExpanded: (hostName: string, totalHosts: number) => boolean;
  toggleContainerExpanded: (containerId: string) => void;
  isContainerExpanded: (containerId: string) => boolean;
  toggleZfsHostExpanded: (hostName: string) => void;
  isZfsHostExpanded: (hostName: string, totalHosts: number) => boolean;
  togglePoolExpanded: (poolId: string) => void;
  isPoolExpanded: (poolId: string, totalPools: number) => boolean;
  toggleVdevExpanded: (vdevId: string) => void;
  isVdevExpanded: (vdevId: string) => boolean;
  setChartWindowSeconds: (seconds: number) => void;
  setDockerDecimal: (key: keyof DecimalSettings, value: boolean) => void;
  setZfsDecimal: (key: 'diskSpeed', value: boolean) => void;
  setProxmoxUpdateInterval: (interval: ProxmoxUpdateInterval) => void;
  toggleProxmoxHostExpanded: (node: string) => void;
  isProxmoxHostExpanded: (node: string) => boolean;
  toggleProxmoxSectionExpanded: (key: string) => void;
  isProxmoxSectionExpanded: (key: string) => boolean;
  setRetention: (key: keyof Settings['retention'], value: number) => void;
  setDockerDebugLogging: (value: boolean) => void;
  setDbFlushDebugLogging: (value: boolean) => void;
  setSseDebugLogging: (value: boolean) => void;
  setLightPalette: (palette: LightPalette) => void;
}

function toggleInSet(raw: string | undefined, item: string): string {
  const set = parseExpandedSet(raw);
  if (set.has(item)) {
    set.delete(item);
  } else {
    set.add(item);
  }
  return JSON.stringify(Array.from(set));
}

export function useSettings(): SettingsValue {
  const settings = useAtomValue(settingsAtom);
  const setRaw = useSetAtom(rawSettingsAtom);
  const { showToast } = useToast();

  const optimisticSet = useCallback(
    (key: string, computeValue: (prev: string | undefined) => string) => {
      let previousValue: string | undefined;
      let newValue: string;

      setRaw(raw => {
        previousValue = raw[key];
        newValue = computeValue(previousValue);
        return { ...raw, [key]: newValue };
      });

      updateSetting({ data: { key, value: newValue! } }).catch(() => {
        setRaw(current => {
          if (previousValue === undefined) {
            const next = { ...current };
            delete next[key];
            return next;
          }
          return { ...current, [key]: previousValue };
        });
        showToast('Failed to save setting');
      });
    },
    [setRaw, showToast]
  );

  const setUse12HourTime = useCallback((value: boolean) => {
    optimisticSet(SETTINGS_KEYS.general.use12HourTime, () => String(value));
  }, [optimisticSet]);

  const setUpdateInterval = useCallback((value: number) => {
    optimisticSet(SETTINGS_KEYS.general.updateIntervalMs, () => String(value));
  }, [optimisticSet]);

  const setMemoryDisplayMode = useCallback((mode: MemoryDisplayMode) => {
    optimisticSet(SETTINGS_KEYS.docker.memoryDisplayMode, () => mode);
  }, [optimisticSet]);

  const setShowSparklines = useCallback((value: boolean) => {
    optimisticSet(SETTINGS_KEYS.general.showSparklines, () => String(value));
  }, [optimisticSet]);

  const setUseAbbreviatedUnits = useCallback((value: boolean) => {
    optimisticSet(SETTINGS_KEYS.general.useAbbreviatedUnits, () => String(value));
  }, [optimisticSet]);

  const toggleHostExpanded = useCallback((hostName: string) => {
    optimisticSet(SETTINGS_KEYS.docker.expandedHosts, prev => toggleInSet(prev, hostName));
  }, [optimisticSet]);

  const isHostExpanded = useCallback(
    (hostName: string, totalHosts: number): boolean => {
      if (totalHosts === 1) return true;
      return !settings.docker.expandedHosts.has(hostName);
    },
    [settings.docker.expandedHosts]
  );

  const toggleContainerExpanded = useCallback((containerId: string) => {
    optimisticSet(SETTINGS_KEYS.docker.expandedContainers, prev => toggleInSet(prev, containerId));
  }, [optimisticSet]);

  const isContainerExpanded = useCallback(
    (containerId: string): boolean => {
      return settings.docker.expandedContainers.has(containerId);
    },
    [settings.docker.expandedContainers]
  );

  const toggleZfsHostExpanded = useCallback((hostName: string) => {
    optimisticSet(SETTINGS_KEYS.zfs.expandedHosts, prev => toggleInSet(prev, hostName));
  }, [optimisticSet]);

  const isZfsHostExpanded = useCallback(
    (hostName: string, totalHosts: number): boolean => {
      if (totalHosts === 1) return true;
      return settings.zfs.expandedHosts.has(hostName);
    },
    [settings.zfs.expandedHosts]
  );

  const togglePoolExpanded = useCallback((poolId: string) => {
    optimisticSet(SETTINGS_KEYS.zfs.expandedPools, prev => toggleInSet(prev, poolId));
  }, [optimisticSet]);

  const isPoolExpanded = useCallback(
    (poolId: string, totalPools: number): boolean => {
      if (totalPools === 1) return true;
      return settings.zfs.expandedPools.has(poolId);
    },
    [settings.zfs.expandedPools]
  );

  const toggleVdevExpanded = useCallback((vdevId: string) => {
    optimisticSet(SETTINGS_KEYS.zfs.expandedVdevs, prev => toggleInSet(prev, vdevId));
  }, [optimisticSet]);

  const isVdevExpanded = useCallback(
    (vdevId: string): boolean => {
      return settings.zfs.expandedVdevs.has(vdevId);
    },
    [settings.zfs.expandedVdevs]
  );

  const setChartWindowSeconds = useCallback((seconds: number) => {
    optimisticSet(SETTINGS_KEYS.docker.chartWindowSeconds, () => String(seconds));
  }, [optimisticSet]);

  const setDockerDecimal = useCallback((key: keyof DecimalSettings, value: boolean) => {
    optimisticSet(SETTINGS_KEYS.docker.decimals[key], () => String(value));
  }, [optimisticSet]);

  const setZfsDecimal = useCallback((key: 'diskSpeed', value: boolean) => {
    optimisticSet(SETTINGS_KEYS.zfs.decimals[key], () => String(value));
  }, [optimisticSet]);

  const setProxmoxUpdateInterval = useCallback((interval: ProxmoxUpdateInterval) => {
    optimisticSet(SETTINGS_KEYS.proxmox.updateInterval, () => String(interval));
  }, [optimisticSet]);

  const toggleProxmoxHostExpanded = useCallback((node: string) => {
    optimisticSet(SETTINGS_KEYS.proxmox.expandedHosts, prev => toggleInSet(prev, node));
  }, [optimisticSet]);

  const isProxmoxHostExpanded = useCallback(
    (node: string): boolean => {
      return settings.proxmox.expandedHosts.has(node);
    },
    [settings.proxmox.expandedHosts]
  );

  const toggleProxmoxSectionExpanded = useCallback((key: string) => {
    optimisticSet(SETTINGS_KEYS.proxmox.expandedSections, prev => toggleInSet(prev, key));
  }, [optimisticSet]);

  const isProxmoxSectionExpanded = useCallback(
    (key: string): boolean => {
      return settings.proxmox.expandedSections.has(key);
    },
    [settings.proxmox.expandedSections]
  );

  const setRetention = useCallback((key: keyof Settings['retention'], value: number) => {
    optimisticSet(SETTINGS_KEYS.retention[key], () => String(value));
  }, [optimisticSet]);

  const setDockerDebugLogging = useCallback((value: boolean) => {
    optimisticSet(SETTINGS_KEYS.developer.dockerDebugLogging, () => String(value));
  }, [optimisticSet]);

  const setDbFlushDebugLogging = useCallback((value: boolean) => {
    optimisticSet(SETTINGS_KEYS.developer.dbFlushDebugLogging, () => String(value));
  }, [optimisticSet]);

  const setSseDebugLogging = useCallback((value: boolean) => {
    optimisticSet(SETTINGS_KEYS.developer.sseDebugLogging, () => String(value));
  }, [optimisticSet]);

  const setLightPalette = useCallback((palette: LightPalette) => {
    optimisticSet(SETTINGS_KEYS.general.lightPalette, () => palette);
  }, [optimisticSet]);

  // All callbacks depend on either `optimisticSet` (stable) or fields within `settings`.
  // When `settings` changes, useMemo re-evaluates and picks up the new callback closures.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo<SettingsValue>(() => ({
    ...settings,
    setUse12HourTime,
    setUpdateInterval,
    setMemoryDisplayMode,
    setShowSparklines,
    setUseAbbreviatedUnits,
    toggleHostExpanded,
    isHostExpanded,
    toggleContainerExpanded,
    isContainerExpanded,
    toggleZfsHostExpanded,
    isZfsHostExpanded,
    togglePoolExpanded,
    isPoolExpanded,
    toggleVdevExpanded,
    isVdevExpanded,
    setChartWindowSeconds,
    setDockerDecimal,
    setZfsDecimal,
    setProxmoxUpdateInterval,
    toggleProxmoxHostExpanded,
    isProxmoxHostExpanded,
    toggleProxmoxSectionExpanded,
    isProxmoxSectionExpanded,
    setRetention,
    setDockerDebugLogging,
    setDbFlushDebugLogging,
    setSseDebugLogging,
    setLightPalette,
  }), [settings]);
}

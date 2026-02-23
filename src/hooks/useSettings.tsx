import { useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  rawSettingsAtom,
  settingsAtom,
  parseExpandedSet,
  type Settings,
  type MemoryDisplayMode,
  type DecimalSettings,
  type ProxmoxUpdateInterval,
} from './settingsAtom';
import { useToast } from './toastAtom';
import { updateSetting } from '@/data/settings.functions';

// Re-export types for backward-compatible imports
export type { Settings, MemoryDisplayMode, DecimalSettings, ProxmoxUpdateInterval } from './settingsAtom';

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
  setDockerDecimal: (key: keyof DecimalSettings, value: boolean) => void;
  setZfsDecimal: (key: 'diskSpeed', value: boolean) => void;
  setProxmoxUpdateInterval: (interval: ProxmoxUpdateInterval) => void;
  setRetention: (key: keyof Settings['retention'], value: number) => void;
  setDockerDebugLogging: (value: boolean) => void;
  setDbFlushDebugLogging: (value: boolean) => void;
  setSseDebugLogging: (value: boolean) => void;
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
    optimisticSet('general/use12HourTime', () => String(value));
  }, [optimisticSet]);

  const setUpdateInterval = useCallback((value: number) => {
    optimisticSet('general/updateIntervalMs', () => String(value));
  }, [optimisticSet]);

  const setMemoryDisplayMode = useCallback((mode: MemoryDisplayMode) => {
    optimisticSet('docker/memoryDisplayMode', () => mode);
  }, [optimisticSet]);

  const setShowSparklines = useCallback((value: boolean) => {
    optimisticSet('general/showSparklines', () => String(value));
  }, [optimisticSet]);

  const setUseAbbreviatedUnits = useCallback((value: boolean) => {
    optimisticSet('general/useAbbreviatedUnits', () => String(value));
  }, [optimisticSet]);

  const toggleHostExpanded = useCallback((hostName: string) => {
    optimisticSet('docker/expandedHosts', prev => toggleInSet(prev, hostName));
  }, [optimisticSet]);

  const isHostExpanded = useCallback(
    (hostName: string, totalHosts: number): boolean => {
      if (totalHosts === 1) return true;
      return settings.docker.expandedHosts.has(hostName);
    },
    [settings.docker.expandedHosts]
  );

  const toggleContainerExpanded = useCallback((containerId: string) => {
    optimisticSet('docker/expandedContainers', prev => toggleInSet(prev, containerId));
  }, [optimisticSet]);

  const isContainerExpanded = useCallback(
    (containerId: string): boolean => {
      return settings.docker.expandedContainers.has(containerId);
    },
    [settings.docker.expandedContainers]
  );

  const toggleZfsHostExpanded = useCallback((hostName: string) => {
    optimisticSet('zfs/expandedHosts', prev => toggleInSet(prev, hostName));
  }, [optimisticSet]);

  const isZfsHostExpanded = useCallback(
    (hostName: string, totalHosts: number): boolean => {
      if (totalHosts === 1) return true;
      return settings.zfs.expandedHosts.has(hostName);
    },
    [settings.zfs.expandedHosts]
  );

  const togglePoolExpanded = useCallback((poolId: string) => {
    optimisticSet('zfs/expandedPools', prev => toggleInSet(prev, poolId));
  }, [optimisticSet]);

  const isPoolExpanded = useCallback(
    (poolId: string, totalPools: number): boolean => {
      if (totalPools === 1) return true;
      return settings.zfs.expandedPools.has(poolId);
    },
    [settings.zfs.expandedPools]
  );

  const toggleVdevExpanded = useCallback((vdevId: string) => {
    optimisticSet('zfs/expandedVdevs', prev => toggleInSet(prev, vdevId));
  }, [optimisticSet]);

  const isVdevExpanded = useCallback(
    (vdevId: string): boolean => {
      return settings.zfs.expandedVdevs.has(vdevId);
    },
    [settings.zfs.expandedVdevs]
  );

  const setDockerDecimal = useCallback((key: keyof DecimalSettings, value: boolean) => {
    optimisticSet(`docker/decimals/${key}`, () => String(value));
  }, [optimisticSet]);

  const setZfsDecimal = useCallback((key: 'diskSpeed', value: boolean) => {
    optimisticSet(`zfs/decimals/${key}`, () => String(value));
  }, [optimisticSet]);

  const setProxmoxUpdateInterval = useCallback((interval: ProxmoxUpdateInterval) => {
    optimisticSet('proxmox/updateInterval', () => String(interval));
  }, [optimisticSet]);

  const setRetention = useCallback((key: keyof Settings['retention'], value: number) => {
    optimisticSet(`retention/${key}`, () => String(value));
  }, [optimisticSet]);

  const setDockerDebugLogging = useCallback((value: boolean) => {
    optimisticSet('developer/dockerDebugLogging', () => String(value));
  }, [optimisticSet]);

  const setDbFlushDebugLogging = useCallback((value: boolean) => {
    optimisticSet('developer/dbFlushDebugLogging', () => String(value));
  }, [optimisticSet]);

  const setSseDebugLogging = useCallback((value: boolean) => {
    optimisticSet('developer/sseDebugLogging', () => String(value));
  }, [optimisticSet]);

  return {
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
    setDockerDecimal,
    setZfsDecimal,
    setProxmoxUpdateInterval,
    setRetention,
    setDockerDebugLogging,
    setDbFlushDebugLogging,
    setSseDebugLogging,
  };
}

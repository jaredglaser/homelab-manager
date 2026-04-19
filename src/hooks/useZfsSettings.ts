import { useCallback, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { zfsSettingsAtom, type Settings } from '@/hooks/settingsAtom';
import { useOptimisticSetting, toggleInSet } from '@/hooks/useOptimisticSetting';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';

export interface ZfsSettingsValue {
  zfs: Settings['zfs'];
  setZfsDecimal: (key: 'diskSpeed', value: boolean) => void;
  toggleZfsHostExpanded: (hostName: string) => void;
  isZfsHostExpanded: (hostName: string, totalHosts: number) => boolean;
  togglePoolExpanded: (poolId: string) => void;
  isPoolExpanded: (poolId: string, totalPools: number) => boolean;
  toggleVdevExpanded: (vdevId: string) => void;
  isVdevExpanded: (vdevId: string) => boolean;
}

/**
 * ZFS-dashboard settings: disk-speed decimals and host / pool / vdev
 * expansion state. Subscribes only to the zfs slice.
 */
export function useZfsSettings(): ZfsSettingsValue {
  const zfs = useAtomValue(zfsSettingsAtom);
  const optimisticSet = useOptimisticSetting();

  const setZfsDecimal = useCallback((key: 'diskSpeed', value: boolean) => {
    optimisticSet(SETTINGS_KEYS.zfs.decimals[key], () => String(value));
  }, [optimisticSet]);

  const toggleZfsHostExpanded = useCallback((hostName: string) => {
    optimisticSet(SETTINGS_KEYS.zfs.expandedHosts, prev => toggleInSet(prev, hostName));
  }, [optimisticSet]);

  const isZfsHostExpanded = useCallback(
    (hostName: string, totalHosts: number): boolean => {
      if (totalHosts === 1) return true;
      return zfs.expandedHosts.has(hostName);
    },
    [zfs.expandedHosts],
  );

  const togglePoolExpanded = useCallback((poolId: string) => {
    optimisticSet(SETTINGS_KEYS.zfs.expandedPools, prev => toggleInSet(prev, poolId));
  }, [optimisticSet]);

  const isPoolExpanded = useCallback(
    (poolId: string, totalPools: number): boolean => {
      if (totalPools === 1) return true;
      return zfs.expandedPools.has(poolId);
    },
    [zfs.expandedPools],
  );

  const toggleVdevExpanded = useCallback((vdevId: string) => {
    optimisticSet(SETTINGS_KEYS.zfs.expandedVdevs, prev => toggleInSet(prev, vdevId));
  }, [optimisticSet]);

  const isVdevExpanded = useCallback(
    (vdevId: string): boolean => zfs.expandedVdevs.has(vdevId),
    [zfs.expandedVdevs],
  );

  return useMemo<ZfsSettingsValue>(() => ({
    zfs,
    setZfsDecimal,
    toggleZfsHostExpanded,
    isZfsHostExpanded,
    togglePoolExpanded,
    isPoolExpanded,
    toggleVdevExpanded,
    isVdevExpanded,
  }), [
    zfs,
    setZfsDecimal,
    toggleZfsHostExpanded,
    isZfsHostExpanded,
    togglePoolExpanded,
    isPoolExpanded,
    toggleVdevExpanded,
    isVdevExpanded,
  ]);
}

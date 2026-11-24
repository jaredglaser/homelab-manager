import { useCallback, useMemo } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { zfsSettingsAtom, type Settings } from '@/hooks/settingsAtom';
import { toggledInSet, zfsExpandedHostsAtom, zfsExpandedPoolsAtom, zfsExpandedVdevsAtom } from '@/hooks/browserLayout';
import { useOptimisticSetting } from '@/hooks/useOptimisticSetting';
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

/** ZFS-dashboard settings: disk-speed decimals are global, host / pool / vdev expansion is kept in this browser. */
export function useZfsSettings(): ZfsSettingsValue {
  const zfs = useAtomValue(zfsSettingsAtom);
  const optimisticSet = useOptimisticSetting();
  const [expandedHosts, setExpandedHosts] = useAtom(zfsExpandedHostsAtom);
  const [expandedPools, setExpandedPools] = useAtom(zfsExpandedPoolsAtom);
  const [expandedVdevs, setExpandedVdevs] = useAtom(zfsExpandedVdevsAtom);

  const setZfsDecimal = useCallback((key: 'diskSpeed', value: boolean) => {
    optimisticSet(SETTINGS_KEYS.zfs.decimals[key], () => String(value));
  }, [optimisticSet]);

  const toggleZfsHostExpanded = useCallback((hostName: string) => {
    setExpandedHosts(prev => toggledInSet(prev, hostName));
  }, [setExpandedHosts]);

  const isZfsHostExpanded = useCallback(
    (hostName: string, totalHosts: number): boolean => {
      if (totalHosts === 1) return true;
      return expandedHosts.has(hostName);
    },
    [expandedHosts],
  );

  const togglePoolExpanded = useCallback((poolId: string) => {
    setExpandedPools(prev => toggledInSet(prev, poolId));
  }, [setExpandedPools]);

  const isPoolExpanded = useCallback(
    (poolId: string, totalPools: number): boolean => {
      if (totalPools === 1) return true;
      return expandedPools.has(poolId);
    },
    [expandedPools],
  );

  const toggleVdevExpanded = useCallback((vdevId: string) => {
    setExpandedVdevs(prev => toggledInSet(prev, vdevId));
  }, [setExpandedVdevs]);

  const isVdevExpanded = useCallback(
    (vdevId: string): boolean => expandedVdevs.has(vdevId),
    [expandedVdevs],
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

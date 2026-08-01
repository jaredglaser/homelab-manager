import { useCallback, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { zfsSettingsAtom, type Settings } from '@/hooks/settingsAtom';
import { useOptimisticSetting } from '@/hooks/useOptimisticSetting';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';

export interface ZfsSettingsValue {
  zfs: Settings['zfs'];
  setZfsDecimal: (key: 'diskSpeed', value: boolean) => void;
}

/**
 * ZFS-dashboard configuration: disk-speed decimals. Host / pool / vdev
 * expansion lives in `useZfsViewState`.
 */
export function useZfsSettings(): ZfsSettingsValue {
  const zfs = useAtomValue(zfsSettingsAtom);
  const optimisticSet = useOptimisticSetting();

  const setZfsDecimal = useCallback((key: 'diskSpeed', value: boolean) => {
    optimisticSet(SETTINGS_KEYS.zfs.decimals[key], () => String(value));
  }, [optimisticSet]);

  return useMemo<ZfsSettingsValue>(() => ({ zfs, setZfsDecimal }), [zfs, setZfsDecimal]);
}

import { useCallback, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import {
  proxmoxSettingsAtom,
  type Settings,
  type ProxmoxUpdateInterval,
} from '@/hooks/settingsAtom';
import { useOptimisticSetting } from '@/hooks/useOptimisticSetting';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';

export interface ProxmoxSettingsValue {
  proxmox: Settings['proxmox'];
  setProxmoxUpdateInterval: (interval: ProxmoxUpdateInterval) => void;
}

/**
 * Proxmox-dashboard configuration: update interval. Host / section expansion
 * lives in `useProxmoxViewState`.
 */
export function useProxmoxSettings(): ProxmoxSettingsValue {
  const proxmox = useAtomValue(proxmoxSettingsAtom);
  const optimisticSet = useOptimisticSetting();

  const setProxmoxUpdateInterval = useCallback((interval: ProxmoxUpdateInterval) => {
    optimisticSet(SETTINGS_KEYS.proxmox.updateInterval, () => String(interval));
  }, [optimisticSet]);

  return useMemo<ProxmoxSettingsValue>(
    () => ({ proxmox, setProxmoxUpdateInterval }),
    [proxmox, setProxmoxUpdateInterval],
  );
}

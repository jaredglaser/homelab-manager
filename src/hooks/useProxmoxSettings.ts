import { useCallback, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import {
  proxmoxSettingsAtom,
  type Settings,
  type ProxmoxUpdateInterval,
} from '@/hooks/settingsAtom';
import { useOptimisticSetting, toggleInSet } from '@/hooks/useOptimisticSetting';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';

export interface ProxmoxSettingsValue {
  proxmox: Settings['proxmox'];
  setProxmoxUpdateInterval: (interval: ProxmoxUpdateInterval) => void;
  toggleProxmoxHostExpanded: (node: string) => void;
  isProxmoxHostExpanded: (node: string) => boolean;
  toggleProxmoxSectionExpanded: (key: string) => void;
  isProxmoxSectionExpanded: (key: string) => boolean;
}

/**
 * Proxmox-dashboard settings: update interval and host / section expansion
 * state. Subscribes only to the proxmox slice.
 */
export function useProxmoxSettings(): ProxmoxSettingsValue {
  const proxmox = useAtomValue(proxmoxSettingsAtom);
  const optimisticSet = useOptimisticSetting();

  const setProxmoxUpdateInterval = useCallback((interval: ProxmoxUpdateInterval) => {
    optimisticSet(SETTINGS_KEYS.proxmox.updateInterval, () => String(interval));
  }, [optimisticSet]);

  const toggleProxmoxHostExpanded = useCallback((node: string) => {
    optimisticSet(SETTINGS_KEYS.proxmox.expandedHosts, prev => toggleInSet(prev, node));
  }, [optimisticSet]);

  // Default expanded: the persisted set stores the *collapsed* nodes (absence
  // = expanded), matching Docker's `isHostExpanded`. Storing expanded nodes
  // instead would make "no saved state" indistinguishable from "everything
  // collapsed" and force a size-based default that flips every row on the
  // first toggle.
  const isProxmoxHostExpanded = useCallback(
    (node: string): boolean => !proxmox.expandedHosts.has(node),
    [proxmox.expandedHosts],
  );

  const toggleProxmoxSectionExpanded = useCallback((key: string) => {
    optimisticSet(SETTINGS_KEYS.proxmox.expandedSections, prev => toggleInSet(prev, key));
  }, [optimisticSet]);

  const isProxmoxSectionExpanded = useCallback(
    (key: string): boolean => !proxmox.expandedSections.has(key),
    [proxmox.expandedSections],
  );

  return useMemo<ProxmoxSettingsValue>(() => ({
    proxmox,
    setProxmoxUpdateInterval,
    toggleProxmoxHostExpanded,
    isProxmoxHostExpanded,
    toggleProxmoxSectionExpanded,
    isProxmoxSectionExpanded,
  }), [
    proxmox,
    setProxmoxUpdateInterval,
    toggleProxmoxHostExpanded,
    isProxmoxHostExpanded,
    toggleProxmoxSectionExpanded,
    isProxmoxSectionExpanded,
  ]);
}

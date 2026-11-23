import { useCallback, useMemo } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import {
  proxmoxSettingsAtom,
  type Settings,
  type ProxmoxUpdateInterval,
} from '@/hooks/settingsAtom';
import { proxmoxCollapsedHostsAtom, proxmoxCollapsedSectionsAtom, toggledInSet } from '@/hooks/browserLayout';
import { useOptimisticSetting } from '@/hooks/useOptimisticSetting';
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
 * Proxmox-dashboard settings: the update interval is global (the worker polls at it), host / section expansion is
 * kept in this browser.
 */
export function useProxmoxSettings(): ProxmoxSettingsValue {
  const proxmox = useAtomValue(proxmoxSettingsAtom);
  const optimisticSet = useOptimisticSetting();
  const [collapsedHosts, setCollapsedHosts] = useAtom(proxmoxCollapsedHostsAtom);
  const [collapsedSections, setCollapsedSections] = useAtom(proxmoxCollapsedSectionsAtom);

  const setProxmoxUpdateInterval = useCallback((interval: ProxmoxUpdateInterval) => {
    optimisticSet(SETTINGS_KEYS.proxmox.updateInterval, () => String(interval));
  }, [optimisticSet]);

  const toggleProxmoxHostExpanded = useCallback((node: string) => {
    setCollapsedHosts(prev => toggledInSet(prev, node));
  }, [setCollapsedHosts]);

  // Storing expanded nodes instead would need a size-based default that flips every row on the first toggle.
  const isProxmoxHostExpanded = useCallback(
    (node: string): boolean => !collapsedHosts.has(node),
    [collapsedHosts],
  );

  const toggleProxmoxSectionExpanded = useCallback((key: string) => {
    setCollapsedSections(prev => toggledInSet(prev, key));
  }, [setCollapsedSections]);

  const isProxmoxSectionExpanded = useCallback(
    (key: string): boolean => !collapsedSections.has(key),
    [collapsedSections],
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

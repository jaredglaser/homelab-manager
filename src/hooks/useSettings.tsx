import { useMemo } from 'react';
import { useDockerSettings, type DockerSettingsValue } from '@/hooks/useDockerSettings';
import { useGeneralSettings, type GeneralSettingsValue } from '@/hooks/useGeneralSettings';
import { useProxmoxSettings, type ProxmoxSettingsValue } from '@/hooks/useProxmoxSettings';
import { useZfsSettings, type ZfsSettingsValue } from '@/hooks/useZfsSettings';

// Re-export types for backward-compatible imports.
export type { Settings, MemoryDisplayMode, DecimalSettings, ProxmoxUpdateInterval, LightPalette } from '@/hooks/settingsAtom';
export { useDockerSettings } from '@/hooks/useDockerSettings';
export { useGeneralSettings } from '@/hooks/useGeneralSettings';
export { useProxmoxSettings } from '@/hooks/useProxmoxSettings';
export { useZfsSettings } from '@/hooks/useZfsSettings';

export type SettingsValue =
  DockerSettingsValue & GeneralSettingsValue & ProxmoxSettingsValue & ZfsSettingsValue;

/**
 * Aggregate hook that composes the four domain-specific hooks.
 *
 * Prefer the domain hooks (useDockerSettings, useZfsSettings,
 * useProxmoxSettings, useGeneralSettings) in new code so components only
 * re-render when their own domain's settings change. This composite is kept
 * for the settings page and any caller that genuinely needs every surface.
 */
export function useSettings(): SettingsValue {
  const docker = useDockerSettings();
  const general = useGeneralSettings();
  const proxmox = useProxmoxSettings();
  const zfs = useZfsSettings();

  return useMemo<SettingsValue>(() => ({
    ...docker,
    ...general,
    ...proxmox,
    ...zfs,
  }), [docker, general, proxmox, zfs]);
}

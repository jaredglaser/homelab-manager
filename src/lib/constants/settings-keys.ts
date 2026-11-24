/**
 * Canonical settings key constants.
 * Every DB key used across frontend (settingsAtom, useSettings) and
 * backend (worker, resolve-collection-interval) should be defined here.
 */
export const SETTINGS_KEYS = {
  general: {
    use12HourTime: 'general/use12HourTime',
    updateIntervalMs: 'general/updateIntervalMs',
    showSparklines: 'general/showSparklines',
    useAbbreviatedUnits: 'general/useAbbreviatedUnits',
    lightPalette: 'general/lightPalette',
  },
  docker: {
    memoryDisplayMode: 'docker/memoryDisplayMode',
    chartWindowSeconds: 'docker/chartWindowSeconds',
    decimals: {
      cpu: 'docker/decimals/cpu',
      memory: 'docker/decimals/memory',
      diskSpeed: 'docker/decimals/diskSpeed',
      networkSpeed: 'docker/decimals/networkSpeed',
    },
  },
  zfs: {
    decimals: {
      diskSpeed: 'zfs/decimals/diskSpeed',
    },
  },
  proxmox: {
    updateInterval: 'proxmox/updateInterval',
  },
  developer: {
    dockerDebugLogging: 'developer/dockerDebugLogging',
    dbFlushDebugLogging: 'developer/dbFlushDebugLogging',
    // Key literal is persisted in the user_settings table and localStorage. Renaming it would reset the user's toggle.
    streamDebugLogging: 'developer/sseDebugLogging',
  },
} as const;

/** Stored per user in `user_settings`. Every other key is a shared server setting in `settings`. */
export const USER_SETTINGS_KEYS = [
  SETTINGS_KEYS.general.use12HourTime,
  SETTINGS_KEYS.general.showSparklines,
  SETTINGS_KEYS.general.useAbbreviatedUnits,
  SETTINGS_KEYS.general.lightPalette,
  SETTINGS_KEYS.docker.memoryDisplayMode,
  SETTINGS_KEYS.docker.chartWindowSeconds,
  SETTINGS_KEYS.docker.decimals.cpu,
  SETTINGS_KEYS.docker.decimals.memory,
  SETTINGS_KEYS.docker.decimals.diskSpeed,
  SETTINGS_KEYS.docker.decimals.networkSpeed,
  SETTINGS_KEYS.zfs.decimals.diskSpeed,
  SETTINGS_KEYS.developer.streamDebugLogging,
] as const;

export type UserSettingsKey = (typeof USER_SETTINGS_KEYS)[number];

export function isUserSettingsKey(key: string): key is UserSettingsKey {
  return (USER_SETTINGS_KEYS as readonly string[]).includes(key);
}

/** localStorage key for persisting demo mode settings. */
export const DEMO_SETTINGS_STORAGE_KEY = 'homelab-demo-settings';

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
    // Key literal is persisted in the DB settings table and localStorage. Renaming it would reset the user's toggle.
    streamDebugLogging: 'developer/sseDebugLogging',
  },
} as const;

/** localStorage key for persisting demo mode settings. */
export const DEMO_SETTINGS_STORAGE_KEY = 'homelab-demo-settings';

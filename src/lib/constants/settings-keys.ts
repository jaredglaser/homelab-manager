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
    expandedHosts: 'docker/expandedHosts',
    expandedContainers: 'docker/expandedContainers',
    containerShells: 'docker/containerShells',
    decimals: {
      cpu: 'docker/decimals/cpu',
      memory: 'docker/decimals/memory',
      diskSpeed: 'docker/decimals/diskSpeed',
      networkSpeed: 'docker/decimals/networkSpeed',
    },
  },
  zfs: {
    expandedHosts: 'zfs/expandedHosts',
    expandedPools: 'zfs/expandedPools',
    expandedVdevs: 'zfs/expandedVdevs',
    decimals: {
      diskSpeed: 'zfs/decimals/diskSpeed',
    },
  },
  proxmox: {
    updateInterval: 'proxmox/updateInterval',
    expandedHosts: 'proxmox/expandedHosts',
    expandedSections: 'proxmox/expandedSections',
  },
  retention: {
    rawDataHours: 'retention/rawDataHours',
    minuteAggDays: 'retention/minuteAggDays',
    hourAggDays: 'retention/hourAggDays',
  },
  developer: {
    dockerDebugLogging: 'developer/dockerDebugLogging',
    dbFlushDebugLogging: 'developer/dbFlushDebugLogging',
    sseDebugLogging: 'developer/sseDebugLogging',
  },
} as const;

/**
 * Keys holding per-view UI state (row expansion, per-container shell choice)
 * rather than configuration. They share the `settings` table but take a
 * different path: loaded once per route into the query cache, never pushed
 * over the settings SSE channel. Every expand/collapse writes one of these,
 * so broadcasting them wakes every connected client on each row click.
 */
export const VIEW_STATE_KEYS = [
  SETTINGS_KEYS.docker.expandedHosts,
  SETTINGS_KEYS.docker.expandedContainers,
  SETTINGS_KEYS.docker.containerShells,
  SETTINGS_KEYS.zfs.expandedHosts,
  SETTINGS_KEYS.zfs.expandedPools,
  SETTINGS_KEYS.zfs.expandedVdevs,
  SETTINGS_KEYS.proxmox.expandedHosts,
  SETTINGS_KEYS.proxmox.expandedSections,
] as const;

export type ViewStateKey = (typeof VIEW_STATE_KEYS)[number];

const VIEW_STATE_KEY_SET: ReadonlySet<string> = new Set(VIEW_STATE_KEYS);

export function isViewStateKey(key: string): key is ViewStateKey {
  return VIEW_STATE_KEY_SET.has(key);
}

/** localStorage key for persisting demo mode settings. */
export const DEMO_SETTINGS_STORAGE_KEY = 'homelab-demo-settings';

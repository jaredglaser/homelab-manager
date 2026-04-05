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
    activeMetricGroup: 'active_metric_group',
  },
  docker: {
    memoryDisplayMode: 'docker/memoryDisplayMode',
    chartWindowSeconds: 'docker/chartWindowSeconds',
    expandedHosts: 'docker/expandedHosts',
    expandedContainers: 'docker/expandedContainers',
    decimals: {
      cpu: 'docker/decimals/cpu',
      memory: 'docker/decimals/memory',
      diskSpeed: 'docker/decimals/diskSpeed',
      networkSpeed: 'docker/decimals/networkSpeed',
    },
  },
  stacks: {
    expandedStacks: 'stacks/expandedStacks',
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

/** DB key for persisting per-tab active metric group index. */
export const ACTIVE_METRIC_GROUP_KEY = SETTINGS_KEYS.general.activeMetricGroup;

/** localStorage key for persisting demo mode settings. */
export const DEMO_SETTINGS_STORAGE_KEY = 'homelab-demo-settings';

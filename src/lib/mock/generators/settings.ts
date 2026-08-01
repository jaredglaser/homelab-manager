import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';
import { DOCKER_ENTITIES } from '@/lib/mock/entities';

const homeassistant = DOCKER_ENTITIES.find(e => e.serviceKey === 'homeassistant')!;

/**
 * Generate default settings matching the canonical settings keys.
 * Values mirror reasonable defaults for a demo environment.
 */
export function generateDefaultSettings(): Record<string, string> {
  return {
    [SETTINGS_KEYS.general.use12HourTime]: 'false',
    [SETTINGS_KEYS.general.updateIntervalMs]: '1000',
    [SETTINGS_KEYS.general.showSparklines]: 'true',
    [SETTINGS_KEYS.general.useAbbreviatedUnits]: 'true',
    [SETTINGS_KEYS.general.lightPalette]: '',

    [SETTINGS_KEYS.docker.memoryDisplayMode]: 'percent',
    [SETTINGS_KEYS.docker.chartWindowSeconds]: '60',
    [SETTINGS_KEYS.docker.expandedHosts]: '[]',
    [SETTINGS_KEYS.docker.expandedContainers]: JSON.stringify([`${homeassistant.host}/${homeassistant.containerId}`]),
    [SETTINGS_KEYS.docker.containerShells]: '{}',
    [SETTINGS_KEYS.docker.decimals.cpu]: '1',
    [SETTINGS_KEYS.docker.decimals.memory]: '1',
    [SETTINGS_KEYS.docker.decimals.diskSpeed]: '1',
    [SETTINGS_KEYS.docker.decimals.networkSpeed]: '1',

    [SETTINGS_KEYS.zfs.expandedHosts]: '[]',
    [SETTINGS_KEYS.zfs.expandedPools]: '[]',
    [SETTINGS_KEYS.zfs.expandedVdevs]: '[]',
    [SETTINGS_KEYS.zfs.decimals.diskSpeed]: '1',

    [SETTINGS_KEYS.proxmox.updateInterval]: '1000',
    [SETTINGS_KEYS.proxmox.expandedHosts]: '[]',
    [SETTINGS_KEYS.proxmox.expandedSections]: '[]',

    [SETTINGS_KEYS.retention.rawDataHours]: '24',
    [SETTINGS_KEYS.retention.minuteAggDays]: '7',
    [SETTINGS_KEYS.retention.hourAggDays]: '30',

    [SETTINGS_KEYS.developer.dockerDebugLogging]: 'false',
    [SETTINGS_KEYS.developer.dbFlushDebugLogging]: 'false',
    [SETTINGS_KEYS.developer.sseDebugLogging]: 'false',
  };
}

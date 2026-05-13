import { atom } from 'jotai';
import { selectAtom } from 'jotai/utils';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';

export type MemoryDisplayMode = 'percentage' | 'bytes';

export type LightPalette = 'cool-blue' | 'warm-slate' | 'forest-mist' | 'soft-stone' | 'dusty-rose';

const VALID_LIGHT_PALETTES: readonly string[] = ['cool-blue', 'warm-slate', 'forest-mist', 'soft-stone', 'dusty-rose'];

export interface DecimalSettings {
  cpu: boolean;
  memory: boolean;
  diskSpeed: boolean;
  networkSpeed: boolean;
}

export type ProxmoxUpdateInterval = 1000 | 10000;

export interface Settings {
  general: {
    use12HourTime: boolean;
    updateIntervalMs: number;
    showSparklines: boolean;
    useAbbreviatedUnits: boolean;
    lightPalette: LightPalette;
  };
  docker: {
    memoryDisplayMode: MemoryDisplayMode;
    chartWindowSeconds: number;
    expandedHosts: Set<string>;
    expandedContainers: Set<string>;
    decimals: DecimalSettings;
    /** Per-container preferred shell, keyed by host/container_name (stable across container recreation; container IDs change on restart). */
    containerShells: Record<string, string>;
  };
  stacks: {
    expandedStacks: Set<string>;
  };
  zfs: {
    expandedHosts: Set<string>;
    expandedPools: Set<string>;
    expandedVdevs: Set<string>;
    decimals: {
      diskSpeed: boolean;
    };
  };
  proxmox: {
    updateInterval: ProxmoxUpdateInterval;
    expandedHosts: Set<string>;
    expandedSections: Set<string>;
  };
  retention: {
    rawDataHours: number;
    minuteAggDays: number;
    hourAggDays: number;
  };
  developer: {
    dockerDebugLogging: boolean;
    dbFlushDebugLogging: boolean;
    sseDebugLogging: boolean;
  };
}

export const DEFAULT_DECIMAL_SETTINGS: DecimalSettings = {
  cpu: false,
  memory: false,
  diskSpeed: false,
  networkSpeed: false,
};

export const DEFAULT_SETTINGS: Settings = {
  general: {
    use12HourTime: true,
    updateIntervalMs: 1000,
    showSparklines: true,
    useAbbreviatedUnits: false,
    lightPalette: 'soft-stone' as LightPalette,
  },
  docker: {
    memoryDisplayMode: 'bytes',
    chartWindowSeconds: 300,
    expandedHosts: new Set(),
    expandedContainers: new Set(),
    decimals: { ...DEFAULT_DECIMAL_SETTINGS },
    containerShells: {},
  },
  stacks: {
    expandedStacks: new Set(),
  },
  zfs: {
    expandedHosts: new Set(),
    expandedPools: new Set(),
    expandedVdevs: new Set(),
    decimals: {
      diskSpeed: false,
    },
  },
  proxmox: {
    updateInterval: 10000,
    expandedHosts: new Set(),
    expandedSections: new Set(),
  },
  retention: {
    rawDataHours: 1,
    minuteAggDays: 3,
    hourAggDays: 30,
  },
  developer: {
    dockerDebugLogging: false,
    dbFlushDebugLogging: false,
    sseDebugLogging: false,
  },
};

const VALID_MEMORY_MODES: readonly string[] = ['percentage', 'bytes'];

function parseLightPalette(raw: string | undefined): LightPalette {
  if (raw !== undefined && VALID_LIGHT_PALETTES.includes(raw)) return raw as LightPalette;
  return DEFAULT_SETTINGS.general.lightPalette;
}

export function parseExpandedSet(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((h): h is string => typeof h === 'string'));
    }
  } catch (err) {
    console.error('Failed to parse expanded set from settings:', err);
  }
  return new Set();
}

export function parseBool(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  return raw === 'true';
}

export function parseIntSetting(raw: string | undefined, defaultValue: number): number {
  if (raw === undefined) return defaultValue;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function parseProxmoxUpdateInterval(raw: string | undefined): ProxmoxUpdateInterval {
  const parsed = parseIntSetting(raw, DEFAULT_SETTINGS.proxmox.updateInterval);
  return parsed === 1000 || parsed === 10000 ? parsed : DEFAULT_SETTINGS.proxmox.updateInterval;
}

export function parseSettings(raw: Record<string, string>): Settings {
  const memMode = raw[SETTINGS_KEYS.docker.memoryDisplayMode];
  return {
    general: {
      use12HourTime: parseBool(raw[SETTINGS_KEYS.general.use12HourTime], DEFAULT_SETTINGS.general.use12HourTime),
      updateIntervalMs: parseIntSetting(raw[SETTINGS_KEYS.general.updateIntervalMs], DEFAULT_SETTINGS.general.updateIntervalMs),
      showSparklines: parseBool(raw[SETTINGS_KEYS.general.showSparklines], DEFAULT_SETTINGS.general.showSparklines),
      useAbbreviatedUnits: parseBool(raw[SETTINGS_KEYS.general.useAbbreviatedUnits], DEFAULT_SETTINGS.general.useAbbreviatedUnits),
      lightPalette: parseLightPalette(raw[SETTINGS_KEYS.general.lightPalette]),
    },
    docker: {
      memoryDisplayMode: VALID_MEMORY_MODES.includes(memMode)
        ? (memMode as MemoryDisplayMode)
        : DEFAULT_SETTINGS.docker.memoryDisplayMode,
      chartWindowSeconds: Math.max(60, Math.min(1800, parseIntSetting(
        raw[SETTINGS_KEYS.docker.chartWindowSeconds],
        DEFAULT_SETTINGS.docker.chartWindowSeconds,
      ))),
      expandedHosts: parseExpandedSet(raw[SETTINGS_KEYS.docker.expandedHosts]),
      expandedContainers: parseExpandedSet(raw[SETTINGS_KEYS.docker.expandedContainers]),
      containerShells: (() => {
        try {
          const v = raw[SETTINGS_KEYS.docker.containerShells];
          if (!v) return {};
          const parsed = JSON.parse(v) as unknown;
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            const result: Record<string, string> = {};
            for (const [k, val] of Object.entries(parsed)) {
              if (typeof k === 'string' && typeof val === 'string') result[k] = val;
            }
            return result;
          }
          return {};
        } catch { return {}; }
      })(),
      decimals: {
        cpu: parseBool(raw[SETTINGS_KEYS.docker.decimals.cpu], DEFAULT_DECIMAL_SETTINGS.cpu),
        memory: parseBool(raw[SETTINGS_KEYS.docker.decimals.memory], DEFAULT_DECIMAL_SETTINGS.memory),
        diskSpeed: parseBool(raw[SETTINGS_KEYS.docker.decimals.diskSpeed], DEFAULT_DECIMAL_SETTINGS.diskSpeed),
        networkSpeed: parseBool(raw[SETTINGS_KEYS.docker.decimals.networkSpeed], DEFAULT_DECIMAL_SETTINGS.networkSpeed),
      },
    },
    stacks: {
      expandedStacks: parseExpandedSet(raw[SETTINGS_KEYS.stacks.expandedStacks]),
    },
    zfs: {
      expandedHosts: parseExpandedSet(raw[SETTINGS_KEYS.zfs.expandedHosts]),
      expandedPools: parseExpandedSet(raw[SETTINGS_KEYS.zfs.expandedPools]),
      expandedVdevs: parseExpandedSet(raw[SETTINGS_KEYS.zfs.expandedVdevs]),
      decimals: {
        diskSpeed: parseBool(raw[SETTINGS_KEYS.zfs.decimals.diskSpeed], DEFAULT_SETTINGS.zfs.decimals.diskSpeed),
      },
    },
    proxmox: {
      updateInterval: parseProxmoxUpdateInterval(raw[SETTINGS_KEYS.proxmox.updateInterval]),
      expandedHosts: parseExpandedSet(raw[SETTINGS_KEYS.proxmox.expandedHosts]),
      expandedSections: parseExpandedSet(raw[SETTINGS_KEYS.proxmox.expandedSections]),
    },
    retention: {
      rawDataHours: parseIntSetting(raw[SETTINGS_KEYS.retention.rawDataHours], DEFAULT_SETTINGS.retention.rawDataHours),
      minuteAggDays: parseIntSetting(raw[SETTINGS_KEYS.retention.minuteAggDays], DEFAULT_SETTINGS.retention.minuteAggDays),
      hourAggDays: parseIntSetting(raw[SETTINGS_KEYS.retention.hourAggDays], DEFAULT_SETTINGS.retention.hourAggDays),
    },
    developer: {
      dockerDebugLogging: parseBool(raw[SETTINGS_KEYS.developer.dockerDebugLogging], DEFAULT_SETTINGS.developer.dockerDebugLogging),
      dbFlushDebugLogging: parseBool(raw[SETTINGS_KEYS.developer.dbFlushDebugLogging], DEFAULT_SETTINGS.developer.dbFlushDebugLogging),
      sseDebugLogging: parseBool(raw[SETTINGS_KEYS.developer.sseDebugLogging], DEFAULT_SETTINGS.developer.sseDebugLogging),
    },
  };
}

/** Raw DB key-value pairs */
export const rawSettingsAtom = atom<Record<string, string>>({});

/** Derived parsed Settings object - recomputes when raw changes */
export const settingsAtom = atom<Settings>((get) => parseSettings(get(rawSettingsAtom)));

/** Transient Proxmox last-update timestamp - not persisted, used to decouple
 *  the update indicator from the data-receiving component (avoids prop drilling
 *  that would re-render the entire Proxmox page on every SSE message). */
export const proxmoxLastUpdateAtom = atom<number>(0);

/**
 * Shallow set equality: compares two Sets by size and membership.
 * parseSettings creates fresh Set instances on every raw change, so plain
 * identity equality would always re-render domain subscribers. Using a
 * structural comparison lets selectAtom short-circuit when the parsed
 * contents match the previous slice.
 */
function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

function generalEqual(a: Settings['general'], b: Settings['general']): boolean {
  return (
    a === b ||
    (a.use12HourTime === b.use12HourTime &&
      a.updateIntervalMs === b.updateIntervalMs &&
      a.showSparklines === b.showSparklines &&
      a.useAbbreviatedUnits === b.useAbbreviatedUnits &&
      a.lightPalette === b.lightPalette)
  );
}

function shellsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  if (a === b) return true;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

function dockerEqual(a: Settings['docker'], b: Settings['docker']): boolean {
  return (
    a === b ||
    (a.memoryDisplayMode === b.memoryDisplayMode &&
      a.chartWindowSeconds === b.chartWindowSeconds &&
      a.decimals.cpu === b.decimals.cpu &&
      a.decimals.memory === b.decimals.memory &&
      a.decimals.diskSpeed === b.decimals.diskSpeed &&
      a.decimals.networkSpeed === b.decimals.networkSpeed &&
      setsEqual(a.expandedHosts, b.expandedHosts) &&
      setsEqual(a.expandedContainers, b.expandedContainers) &&
      shellsEqual(a.containerShells, b.containerShells))
  );
}

function stacksEqual(a: Settings['stacks'], b: Settings['stacks']): boolean {
  return a === b || setsEqual(a.expandedStacks, b.expandedStacks);
}

function zfsEqual(a: Settings['zfs'], b: Settings['zfs']): boolean {
  return (
    a === b ||
    (a.decimals.diskSpeed === b.decimals.diskSpeed &&
      setsEqual(a.expandedHosts, b.expandedHosts) &&
      setsEqual(a.expandedPools, b.expandedPools) &&
      setsEqual(a.expandedVdevs, b.expandedVdevs))
  );
}

function proxmoxEqual(a: Settings['proxmox'], b: Settings['proxmox']): boolean {
  return (
    a === b ||
    (a.updateInterval === b.updateInterval &&
      setsEqual(a.expandedHosts, b.expandedHosts) &&
      setsEqual(a.expandedSections, b.expandedSections))
  );
}

function retentionEqual(a: Settings['retention'], b: Settings['retention']): boolean {
  return (
    a === b ||
    (a.rawDataHours === b.rawDataHours &&
      a.minuteAggDays === b.minuteAggDays &&
      a.hourAggDays === b.hourAggDays)
  );
}

function developerEqual(a: Settings['developer'], b: Settings['developer']): boolean {
  return (
    a === b ||
    (a.dockerDebugLogging === b.dockerDebugLogging &&
      a.dbFlushDebugLogging === b.dbFlushDebugLogging &&
      a.sseDebugLogging === b.sseDebugLogging)
  );
}

/**
 * Domain-scoped derived atoms. Each selects one slice of `settingsAtom` and
 * re-emits only when that slice differs structurally from the previous value.
 * Components subscribing via useGeneralSettings/useDockerSettings/etc. only
 * re-render when their own domain changes: e.g. toggling a Docker host
 * expansion no longer re-renders ZFS or Proxmox components.
 */
export const generalSettingsAtom = selectAtom(settingsAtom, (s) => s.general, generalEqual);
export const dockerSettingsAtom = selectAtom(settingsAtom, (s) => s.docker, dockerEqual);
export const stacksSettingsAtom = selectAtom(settingsAtom, (s) => s.stacks, stacksEqual);
export const zfsSettingsAtom = selectAtom(settingsAtom, (s) => s.zfs, zfsEqual);
export const proxmoxSettingsAtom = selectAtom(settingsAtom, (s) => s.proxmox, proxmoxEqual);
export const retentionSettingsAtom = selectAtom(settingsAtom, (s) => s.retention, retentionEqual);
export const developerSettingsAtom = selectAtom(settingsAtom, (s) => s.developer, developerEqual);

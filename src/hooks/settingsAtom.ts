import { atom } from 'jotai';

export type MemoryDisplayMode = 'percentage' | 'bytes';

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
  };
  docker: {
    memoryDisplayMode: MemoryDisplayMode;
    expandedHosts: Set<string>;
    expandedContainers: Set<string>;
    decimals: DecimalSettings;
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
  },
  docker: {
    memoryDisplayMode: 'bytes',
    expandedHosts: new Set(),
    expandedContainers: new Set(),
    decimals: { ...DEFAULT_DECIMAL_SETTINGS },
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

export function parseExpandedSet(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((h): h is string => typeof h === 'string'));
    }
  } catch {
    // Invalid JSON - return empty set
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
  const memMode = raw['docker/memoryDisplayMode'];
  return {
    general: {
      use12HourTime: parseBool(raw['general/use12HourTime'], DEFAULT_SETTINGS.general.use12HourTime),
      updateIntervalMs: parseIntSetting(raw['general/updateIntervalMs'], DEFAULT_SETTINGS.general.updateIntervalMs),
      showSparklines: parseBool(raw['general/showSparklines'], DEFAULT_SETTINGS.general.showSparklines),
      useAbbreviatedUnits: parseBool(raw['general/useAbbreviatedUnits'], DEFAULT_SETTINGS.general.useAbbreviatedUnits),
    },
    docker: {
      memoryDisplayMode: VALID_MEMORY_MODES.includes(memMode)
        ? (memMode as MemoryDisplayMode)
        : DEFAULT_SETTINGS.docker.memoryDisplayMode,
      expandedHosts: parseExpandedSet(raw['docker/expandedHosts']),
      expandedContainers: parseExpandedSet(raw['docker/expandedContainers']),
      decimals: {
        cpu: parseBool(raw['docker/decimals/cpu'], DEFAULT_DECIMAL_SETTINGS.cpu),
        memory: parseBool(raw['docker/decimals/memory'], DEFAULT_DECIMAL_SETTINGS.memory),
        diskSpeed: parseBool(raw['docker/decimals/diskSpeed'], DEFAULT_DECIMAL_SETTINGS.diskSpeed),
        networkSpeed: parseBool(raw['docker/decimals/networkSpeed'], DEFAULT_DECIMAL_SETTINGS.networkSpeed),
      },
    },
    zfs: {
      expandedHosts: parseExpandedSet(raw['zfs/expandedHosts']),
      expandedPools: parseExpandedSet(raw['zfs/expandedPools']),
      expandedVdevs: parseExpandedSet(raw['zfs/expandedVdevs']),
      decimals: {
        diskSpeed: parseBool(raw['zfs/decimals/diskSpeed'], DEFAULT_SETTINGS.zfs.decimals.diskSpeed),
      },
    },
    proxmox: {
      updateInterval: parseProxmoxUpdateInterval(raw['proxmox/updateInterval']),
      expandedHosts: parseExpandedSet(raw['proxmox/expandedHosts']),
      expandedSections: parseExpandedSet(raw['proxmox/expandedSections']),
    },
    retention: {
      rawDataHours: parseIntSetting(raw['retention/rawDataHours'], DEFAULT_SETTINGS.retention.rawDataHours),
      minuteAggDays: parseIntSetting(raw['retention/minuteAggDays'], DEFAULT_SETTINGS.retention.minuteAggDays),
      hourAggDays: parseIntSetting(raw['retention/hourAggDays'], DEFAULT_SETTINGS.retention.hourAggDays),
    },
    developer: {
      dockerDebugLogging: parseBool(raw['developer/dockerDebugLogging'], DEFAULT_SETTINGS.developer.dockerDebugLogging),
      dbFlushDebugLogging: parseBool(raw['developer/dbFlushDebugLogging'], DEFAULT_SETTINGS.developer.dbFlushDebugLogging),
      sseDebugLogging: parseBool(raw['developer/sseDebugLogging'], DEFAULT_SETTINGS.developer.sseDebugLogging),
    },
  };
}

/** Raw DB key-value pairs */
export const rawSettingsAtom = atom<Record<string, string>>({});

/** Derived parsed Settings object — recomputes when raw changes */
export const settingsAtom = atom<Settings>((get) => parseSettings(get(rawSettingsAtom)));

/** Transient Proxmox last-update timestamp — not persisted, used to decouple
 *  the update indicator from the data-receiving component (avoids prop drilling
 *  that would re-render the entire Proxmox page on every SSE message). */
export const proxmoxLastUpdateAtom = atom<number>(0);

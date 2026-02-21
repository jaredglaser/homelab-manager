import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { getAllSettings, updateSetting } from '@/data/settings.functions';

export type MemoryDisplayMode = 'percentage' | 'bytes';

export interface DecimalSettings {
  cpu: boolean;
  memory: boolean;
  diskSpeed: boolean;
  networkSpeed: boolean;
}

export interface Settings {
  general: {
    use12HourTime: boolean;
    updateIntervalMs: number;
  };
  docker: {
    memoryDisplayMode: MemoryDisplayMode;
    showSparklines: boolean;
    useAbbreviatedUnits: boolean;
    expandedHosts: Set<string>;
    expandedContainers: Set<string>;
    decimals: DecimalSettings;
  };
  zfs: {
    expandedPools: Set<string>;
    expandedVdevs: Set<string>;
    decimals: {
      diskSpeed: boolean;
    };
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

interface SettingsContextValue extends Settings {
  setUse12HourTime: (value: boolean) => void;
  setUpdateInterval: (value: number) => void;
  setMemoryDisplayMode: (mode: MemoryDisplayMode) => void;
  setShowSparklines: (value: boolean) => void;
  setUseAbbreviatedUnits: (value: boolean) => void;
  toggleHostExpanded: (hostName: string) => void;
  isHostExpanded: (hostName: string, totalHosts: number) => boolean;
  toggleContainerExpanded: (containerId: string) => void;
  isContainerExpanded: (containerId: string) => boolean;
  togglePoolExpanded: (poolName: string) => void;
  isPoolExpanded: (poolName: string, totalPools: number) => boolean;
  toggleVdevExpanded: (vdevId: string) => void;
  isVdevExpanded: (vdevId: string) => boolean;
  setDockerDecimal: (key: keyof DecimalSettings, value: boolean) => void;
  setZfsDecimal: (key: 'diskSpeed', value: boolean) => void;
  setRetention: (key: keyof Settings['retention'], value: number) => void;
  setDockerDebugLogging: (value: boolean) => void;
  setDbFlushDebugLogging: (value: boolean) => void;
  setSseDebugLogging: (value: boolean) => void;
}

const DEFAULT_DECIMAL_SETTINGS: DecimalSettings = {
  cpu: false,
  memory: false,
  diskSpeed: false,
  networkSpeed: false,
};

const DEFAULT_SETTINGS: Settings = {
  general: {
    use12HourTime: true,
    updateIntervalMs: 1000,
  },
  docker: {
    memoryDisplayMode: 'percentage',
    showSparklines: true,
    useAbbreviatedUnits: false,
    expandedHosts: new Set(),
    expandedContainers: new Set(),
    decimals: { ...DEFAULT_DECIMAL_SETTINGS },
  },
  zfs: {
    expandedPools: new Set(),
    expandedVdevs: new Set(),
    decimals: {
      diskSpeed: false,
    },
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

function parseExpandedSet(raw: string | undefined): Set<string> {
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

function parseBool(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  return raw === 'true';
}

function parseIntSetting(raw: string | undefined, defaultValue: number): number {
  if (raw === undefined) return defaultValue;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function parseSettings(raw: Record<string, string>): Settings {
  const memMode = raw['docker/memoryDisplayMode'];
  return {
    general: {
      use12HourTime: parseBool(raw['general/use12HourTime'], DEFAULT_SETTINGS.general.use12HourTime),
      updateIntervalMs: parseIntSetting(raw['general/updateIntervalMs'], DEFAULT_SETTINGS.general.updateIntervalMs),
    },
    docker: {
      memoryDisplayMode: VALID_MEMORY_MODES.includes(memMode)
        ? (memMode as MemoryDisplayMode)
        : DEFAULT_SETTINGS.docker.memoryDisplayMode,
      showSparklines: parseBool(raw['docker/showSparklines'], DEFAULT_SETTINGS.docker.showSparklines),
      useAbbreviatedUnits: parseBool(raw['docker/useAbbreviatedUnits'], DEFAULT_SETTINGS.docker.useAbbreviatedUnits),
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
      expandedPools: parseExpandedSet(raw['zfs/expandedPools']),
      expandedVdevs: parseExpandedSet(raw['zfs/expandedVdevs']),
      decimals: {
        diskSpeed: parseBool(raw['zfs/decimals/diskSpeed'], DEFAULT_SETTINGS.zfs.decimals.diskSpeed),
      },
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

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  useEffect(() => {
    getAllSettings().then(raw => {
      setSettings(parseSettings(raw));
    }).catch(() => {
      // DB unavailable — keep defaults
    });
  }, []);

  const setUse12HourTime = useCallback((value: boolean) => {
    setSettings(prev => ({
      ...prev,
      general: { ...prev.general, use12HourTime: value },
    }));
    updateSetting({ data: { key: 'general/use12HourTime', value: String(value) } }).catch(() => {
      // Fire-and-forget
    });
  }, []);

  const setUpdateInterval = useCallback((value: number) => {
    setSettings(prev => ({
      ...prev,
      general: { ...prev.general, updateIntervalMs: value },
    }));
    updateSetting({ data: { key: 'general/updateIntervalMs', value: String(value) } }).catch(() => {
      // Fire-and-forget
    });
  }, []);

  const setMemoryDisplayMode = useCallback((mode: MemoryDisplayMode) => {
    setSettings(prev => ({
      ...prev,
      docker: { ...prev.docker, memoryDisplayMode: mode },
    }));
    updateSetting({ data: { key: 'docker/memoryDisplayMode', value: mode } }).catch(() => {
      // Fire-and-forget; optimistic update already applied
    });
  }, []);

  const setShowSparklines = useCallback((value: boolean) => {
    setSettings(prev => ({
      ...prev,
      docker: { ...prev.docker, showSparklines: value },
    }));
    updateSetting({ data: { key: 'docker/showSparklines', value: String(value) } }).catch(() => {
      // Fire-and-forget
    });
  }, []);

  const setUseAbbreviatedUnits = useCallback((value: boolean) => {
    setSettings(prev => ({
      ...prev,
      docker: { ...prev.docker, useAbbreviatedUnits: value },
    }));
    updateSetting({ data: { key: 'docker/useAbbreviatedUnits', value: String(value) } }).catch(() => {
      // Fire-and-forget
    });
  }, []);

  const toggleHostExpanded = useCallback((hostName: string) => {
    setSettings(prev => {
      const newExpanded = new Set(prev.docker.expandedHosts);
      if (newExpanded.has(hostName)) {
        newExpanded.delete(hostName);
      } else {
        newExpanded.add(hostName);
      }

      // Persist to DB
      updateSetting({
        data: {
          key: 'docker/expandedHosts',
          value: JSON.stringify(Array.from(newExpanded)),
        },
      }).catch(() => {
        // Fire-and-forget
      });

      return {
        ...prev,
        docker: { ...prev.docker, expandedHosts: newExpanded },
      };
    });
  }, []);

  const isHostExpanded = useCallback(
    (hostName: string, totalHosts: number): boolean => {
      // If only one host, always expanded
      if (totalHosts === 1) return true;
      // Otherwise check the stored state (default collapsed)
      return settings.docker.expandedHosts.has(hostName);
    },
    [settings.docker.expandedHosts]
  );

  const toggleContainerExpanded = useCallback((containerId: string) => {
    setSettings(prev => {
      const newExpanded = new Set(prev.docker.expandedContainers);
      if (newExpanded.has(containerId)) {
        newExpanded.delete(containerId);
      } else {
        newExpanded.add(containerId);
      }

      // Persist to DB
      updateSetting({
        data: {
          key: 'docker/expandedContainers',
          value: JSON.stringify(Array.from(newExpanded)),
        },
      }).catch(() => {
        // Fire-and-forget
      });

      return {
        ...prev,
        docker: { ...prev.docker, expandedContainers: newExpanded },
      };
    });
  }, []);

  const isContainerExpanded = useCallback(
    (containerId: string): boolean => {
      return settings.docker.expandedContainers.has(containerId);
    },
    [settings.docker.expandedContainers]
  );

  const togglePoolExpanded = useCallback((poolName: string) => {
    setSettings(prev => {
      const newExpanded = new Set(prev.zfs.expandedPools);
      if (newExpanded.has(poolName)) {
        newExpanded.delete(poolName);
      } else {
        newExpanded.add(poolName);
      }

      // Persist to DB
      updateSetting({
        data: {
          key: 'zfs/expandedPools',
          value: JSON.stringify(Array.from(newExpanded)),
        },
      }).catch(() => {
        // Fire-and-forget
      });

      return {
        ...prev,
        zfs: { ...prev.zfs, expandedPools: newExpanded },
      };
    });
  }, []);

  const isPoolExpanded = useCallback(
    (poolName: string, totalPools: number): boolean => {
      // If only one pool, always expanded
      if (totalPools === 1) return true;
      // Otherwise check the stored state (default collapsed)
      return settings.zfs.expandedPools.has(poolName);
    },
    [settings.zfs.expandedPools]
  );

  const toggleVdevExpanded = useCallback((vdevId: string) => {
    setSettings(prev => {
      const newExpanded = new Set(prev.zfs.expandedVdevs);
      if (newExpanded.has(vdevId)) {
        newExpanded.delete(vdevId);
      } else {
        newExpanded.add(vdevId);
      }

      updateSetting({
        data: {
          key: 'zfs/expandedVdevs',
          value: JSON.stringify(Array.from(newExpanded)),
        },
      }).catch(() => {
        // Fire-and-forget
      });

      return {
        ...prev,
        zfs: { ...prev.zfs, expandedVdevs: newExpanded },
      };
    });
  }, []);

  const isVdevExpanded = useCallback(
    (vdevId: string): boolean => {
      return settings.zfs.expandedVdevs.has(vdevId);
    },
    [settings.zfs.expandedVdevs]
  );

  const setDockerDecimal = useCallback((key: keyof DecimalSettings, value: boolean) => {
    setSettings(prev => ({
      ...prev,
      docker: {
        ...prev.docker,
        decimals: { ...prev.docker.decimals, [key]: value },
      },
    }));
    updateSetting({ data: { key: `docker/decimals/${key}`, value: String(value) } }).catch(() => {
      // Fire-and-forget
    });
  }, []);

  const setZfsDecimal = useCallback((key: 'diskSpeed', value: boolean) => {
    setSettings(prev => ({
      ...prev,
      zfs: {
        ...prev.zfs,
        decimals: { ...prev.zfs.decimals, [key]: value },
      },
    }));
    updateSetting({ data: { key: `zfs/decimals/${key}`, value: String(value) } }).catch(() => {
      // Fire-and-forget
    });
  }, []);

  const setRetention = useCallback((key: keyof Settings['retention'], value: number) => {
    setSettings(prev => ({
      ...prev,
      retention: { ...prev.retention, [key]: value },
    }));
    updateSetting({ data: { key: `retention/${key}`, value: String(value) } }).catch(() => {
      // Fire-and-forget
    });
  }, []);

  const setDockerDebugLogging = useCallback((value: boolean) => {
    setSettings(prev => ({
      ...prev,
      developer: { ...prev.developer, dockerDebugLogging: value },
    }));
    updateSetting({ data: { key: 'developer/dockerDebugLogging', value: String(value) } }).catch(() => {
      // Fire-and-forget
    });
  }, []);

  const setDbFlushDebugLogging = useCallback((value: boolean) => {
    setSettings(prev => ({
      ...prev,
      developer: { ...prev.developer, dbFlushDebugLogging: value },
    }));
    updateSetting({ data: { key: 'developer/dbFlushDebugLogging', value: String(value) } }).catch(() => {
      // Fire-and-forget
    });
  }, []);

  const setSseDebugLogging = useCallback((value: boolean) => {
    setSettings(prev => ({
      ...prev,
      developer: { ...prev.developer, sseDebugLogging: value },
    }));
    updateSetting({ data: { key: 'developer/sseDebugLogging', value: String(value) } }).catch(() => {
      // Fire-and-forget
    });
  }, []);

  return (
    <SettingsContext.Provider
      value={{
        ...settings,
        setUse12HourTime,
        setUpdateInterval,
        setMemoryDisplayMode,
        setShowSparklines,
        setUseAbbreviatedUnits,
        toggleHostExpanded,
        isHostExpanded,
        toggleContainerExpanded,
        isContainerExpanded,
        togglePoolExpanded,
        isPoolExpanded,
        toggleVdevExpanded,
        isVdevExpanded,
        setDockerDecimal,
        setZfsDecimal,
        setRetention,
        setDockerDebugLogging,
        setDbFlushDebugLogging,
        setSseDebugLogging,
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return ctx;
}

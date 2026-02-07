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
  docker: {
    memoryDisplayMode: MemoryDisplayMode;
    expandedHosts: Set<string>;
    expandedContainers: Set<string>;
    decimals: DecimalSettings;
  };
  zfs: {
    expandedPools: Set<string>;
    decimals: {
      diskSpeed: boolean;
    };
  };
}

interface SettingsContextValue extends Settings {
  setMemoryDisplayMode: (mode: MemoryDisplayMode) => void;
  toggleHostExpanded: (hostName: string) => void;
  isHostExpanded: (hostName: string, totalHosts: number) => boolean;
  toggleContainerExpanded: (containerId: string) => void;
  isContainerExpanded: (containerId: string) => boolean;
  togglePoolExpanded: (poolName: string) => void;
  isPoolExpanded: (poolName: string, totalPools: number) => boolean;
  setDockerDecimal: (key: keyof DecimalSettings, value: boolean) => void;
  setZfsDecimal: (key: 'diskSpeed', value: boolean) => void;
}

const DEFAULT_DECIMAL_SETTINGS: DecimalSettings = {
  cpu: false,
  memory: false,
  diskSpeed: false,
  networkSpeed: false,
};

const DEFAULT_SETTINGS: Settings = {
  docker: {
    memoryDisplayMode: 'percentage',
    expandedHosts: new Set(),
    expandedContainers: new Set(),
    decimals: { ...DEFAULT_DECIMAL_SETTINGS },
  },
  zfs: {
    expandedPools: new Set(),
    decimals: {
      diskSpeed: false,
    },
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

function parseSettings(raw: Record<string, string>): Settings {
  const memMode = raw['docker/memoryDisplayMode'];
  return {
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
      expandedPools: parseExpandedSet(raw['zfs/expandedPools']),
      decimals: {
        diskSpeed: parseBool(raw['zfs/decimals/diskSpeed'], DEFAULT_SETTINGS.zfs.decimals.diskSpeed),
      },
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

  const setMemoryDisplayMode = useCallback((mode: MemoryDisplayMode) => {
    setSettings(prev => ({
      ...prev,
      docker: { ...prev.docker, memoryDisplayMode: mode },
    }));
    updateSetting({ data: { key: 'docker/memoryDisplayMode', value: mode } }).catch(() => {
      // Fire-and-forget; optimistic update already applied
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

  return (
    <SettingsContext.Provider
      value={{
        ...settings,
        setMemoryDisplayMode,
        toggleHostExpanded,
        isHostExpanded,
        toggleContainerExpanded,
        isContainerExpanded,
        togglePoolExpanded,
        isPoolExpanded,
        setDockerDecimal,
        setZfsDecimal,
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

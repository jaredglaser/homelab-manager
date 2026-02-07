import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { getAllSettings, updateSetting } from '@/data/settings.functions';

export type MemoryDisplayMode = 'percentage' | 'bytes';

export interface Settings {
  docker: {
    memoryDisplayMode: MemoryDisplayMode;
    expandedHosts: Set<string>;
  };
  zfs: {
    expandedPools: Set<string>;
  };
}

interface SettingsContextValue extends Settings {
  setMemoryDisplayMode: (mode: MemoryDisplayMode) => void;
  toggleHostExpanded: (hostName: string) => void;
  isHostExpanded: (hostName: string, totalHosts: number) => boolean;
  togglePoolExpanded: (poolName: string) => void;
  isPoolExpanded: (poolName: string, totalPools: number) => boolean;
}

const DEFAULT_SETTINGS: Settings = {
  docker: {
    memoryDisplayMode: 'percentage',
    expandedHosts: new Set(),
  },
  zfs: {
    expandedPools: new Set(),
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

function parseSettings(raw: Record<string, string>): Settings {
  const memMode = raw['docker/memoryDisplayMode'];
  return {
    docker: {
      memoryDisplayMode: VALID_MEMORY_MODES.includes(memMode)
        ? (memMode as MemoryDisplayMode)
        : DEFAULT_SETTINGS.docker.memoryDisplayMode,
      expandedHosts: parseExpandedSet(raw['docker/expandedHosts']),
    },
    zfs: {
      expandedPools: parseExpandedSet(raw['zfs/expandedPools']),
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

  return (
    <SettingsContext.Provider
      value={{
        ...settings,
        setMemoryDisplayMode,
        toggleHostExpanded,
        isHostExpanded,
        togglePoolExpanded,
        isPoolExpanded,
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

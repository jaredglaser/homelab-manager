import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { getAllSettings, updateSetting } from '@/data/settings.functions';

export type MemoryDisplayMode = 'percentage' | 'bytes';

export interface Settings {
  docker: {
    memoryDisplayMode: MemoryDisplayMode;
  };
}

interface SettingsContextValue extends Settings {
  setMemoryDisplayMode: (mode: MemoryDisplayMode) => void;
}

const DEFAULT_SETTINGS: Settings = {
  docker: {
    memoryDisplayMode: 'percentage',
  },
};

const VALID_MEMORY_MODES: readonly string[] = ['percentage', 'bytes'];

function parseSettings(raw: Record<string, string>): Settings {
  const memMode = raw['docker/memoryDisplayMode'];
  return {
    docker: {
      memoryDisplayMode: VALID_MEMORY_MODES.includes(memMode)
        ? (memMode as MemoryDisplayMode)
        : DEFAULT_SETTINGS.docker.memoryDisplayMode,
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

  return (
    <SettingsContext.Provider value={{ ...settings, setMemoryDisplayMode }}>
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

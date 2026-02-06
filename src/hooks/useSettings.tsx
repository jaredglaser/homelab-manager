import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

export type MemoryDisplayMode = 'percentage' | 'bytes';

interface Settings {
  docker: {
    memoryDisplayMode: MemoryDisplayMode;
  };
}

interface SettingsContextValue extends Settings {
  setMemoryDisplayMode: (mode: MemoryDisplayMode) => void;
}

const STORAGE_KEY = 'homelab-settings';

const DEFAULT_SETTINGS: Settings = {
  docker: {
    memoryDisplayMode: 'percentage',
  },
};

function loadSettings(): Settings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return {
        docker: {
          memoryDisplayMode: parsed?.docker?.memoryDisplayMode ?? DEFAULT_SETTINGS.docker.memoryDisplayMode,
        },
      };
    }
  } catch {
    // Ignore parse errors, use defaults
  }
  return DEFAULT_SETTINGS;
}

function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage errors (e.g., private browsing quota)
  }
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(loadSettings);

  const setMemoryDisplayMode = useCallback((mode: MemoryDisplayMode) => {
    setSettings(prev => {
      const next = { ...prev, docker: { ...prev.docker, memoryDisplayMode: mode } };
      saveSettings(next);
      return next;
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

import { useCallback, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import {
  generalSettingsAtom,
  retentionSettingsAtom,
  developerSettingsAtom,
  type Settings,
  type LightPalette,
} from '@/hooks/settingsAtom';
import { useOptimisticSetting } from '@/hooks/useOptimisticSetting';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';

export interface GeneralSettingsValue {
  general: Settings['general'];
  retention: Settings['retention'];
  developer: Settings['developer'];
  setUse12HourTime: (value: boolean) => void;
  setUpdateInterval: (value: number) => void;
  setShowSparklines: (value: boolean) => void;
  setUseAbbreviatedUnits: (value: boolean) => void;
  setLightPalette: (palette: LightPalette) => void;
  setRetention: (key: keyof Settings['retention'], value: number) => void;
  setDockerDebugLogging: (value: boolean) => void;
  setDbFlushDebugLogging: (value: boolean) => void;
  setSseDebugLogging: (value: boolean) => void;
}

/**
 * Cross-cutting app settings: theme/time format, data update cadence, unit
 * formatting, retention windows, and developer debug toggles. Subscribes only
 * to the general/retention/developer slices: Docker, ZFS, and Proxmox
 * changes do not re-render consumers.
 */
export function useGeneralSettings(): GeneralSettingsValue {
  const general = useAtomValue(generalSettingsAtom);
  const retention = useAtomValue(retentionSettingsAtom);
  const developer = useAtomValue(developerSettingsAtom);
  const optimisticSet = useOptimisticSetting();

  const setUse12HourTime = useCallback((value: boolean) => {
    optimisticSet(SETTINGS_KEYS.general.use12HourTime, () => String(value));
  }, [optimisticSet]);

  const setUpdateInterval = useCallback((value: number) => {
    optimisticSet(SETTINGS_KEYS.general.updateIntervalMs, () => String(value));
  }, [optimisticSet]);

  const setShowSparklines = useCallback((value: boolean) => {
    optimisticSet(SETTINGS_KEYS.general.showSparklines, () => String(value));
  }, [optimisticSet]);

  const setUseAbbreviatedUnits = useCallback((value: boolean) => {
    optimisticSet(SETTINGS_KEYS.general.useAbbreviatedUnits, () => String(value));
  }, [optimisticSet]);

  const setLightPalette = useCallback((palette: LightPalette) => {
    optimisticSet(SETTINGS_KEYS.general.lightPalette, () => palette);
  }, [optimisticSet]);

  const setRetention = useCallback((key: keyof Settings['retention'], value: number) => {
    optimisticSet(SETTINGS_KEYS.retention[key], () => String(value));
  }, [optimisticSet]);

  const setDockerDebugLogging = useCallback((value: boolean) => {
    optimisticSet(SETTINGS_KEYS.developer.dockerDebugLogging, () => String(value));
  }, [optimisticSet]);

  const setDbFlushDebugLogging = useCallback((value: boolean) => {
    optimisticSet(SETTINGS_KEYS.developer.dbFlushDebugLogging, () => String(value));
  }, [optimisticSet]);

  const setSseDebugLogging = useCallback((value: boolean) => {
    optimisticSet(SETTINGS_KEYS.developer.sseDebugLogging, () => String(value));
  }, [optimisticSet]);

  return useMemo<GeneralSettingsValue>(() => ({
    general,
    retention,
    developer,
    setUse12HourTime,
    setUpdateInterval,
    setShowSparklines,
    setUseAbbreviatedUnits,
    setLightPalette,
    setRetention,
    setDockerDebugLogging,
    setDbFlushDebugLogging,
    setSseDebugLogging,
  }), [
    general,
    retention,
    developer,
    setUse12HourTime,
    setUpdateInterval,
    setShowSparklines,
    setUseAbbreviatedUnits,
    setLightPalette,
    setRetention,
    setDockerDebugLogging,
    setDbFlushDebugLogging,
    setSseDebugLogging,
  ]);
}

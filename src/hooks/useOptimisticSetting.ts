import { useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { rawSettingsAtom } from '@/hooks/settingsAtom';
import { useToast } from '@/hooks/toastAtom';
import { updateSetting } from '@/data/settings/functions';
import type { SettingsKey } from '@/data/settings/schemas';

export type OptimisticSetter = (
  key: SettingsKey,
  computeValue: (prev: string | undefined) => string,
) => void;

/**
 * Shared optimistic-update primitive used by every domain settings hook.
 *
 * Writes the new value into `rawSettingsAtom` immediately, then persists to
 * the database. On persist failure the previous value is restored and a
 * toast is shown. Only subscribes to the raw atom's setter, not its value,
 * so the hook itself never triggers a re-render when any setting changes.
 */
export function useOptimisticSetting(): OptimisticSetter {
  const setRaw = useSetAtom(rawSettingsAtom);
  const { showToast } = useToast();

  return useCallback<OptimisticSetter>(
    (key, computeValue) => {
      let previousValue: string | undefined;
      let newValue: string;

      setRaw(raw => {
        previousValue = raw[key];
        newValue = computeValue(previousValue);
        return { ...raw, [key]: newValue };
      });

      updateSetting({ data: { key, value: newValue! } }).catch((err: unknown) => {
        console.error(`Failed to persist setting "${key}":`, err);
        setRaw(current => {
          if (previousValue === undefined) {
            const next = { ...current };
            delete next[key];
            return next;
          }
          return { ...current, [key]: previousValue };
        });
        showToast('Failed to save setting', 'error');
      });
    },
    [setRaw, showToast],
  );
}

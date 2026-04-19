import { useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { rawSettingsAtom, parseExpandedSet } from '@/hooks/settingsAtom';
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
        showToast('Failed to save setting');
      });
    },
    [setRaw, showToast],
  );
}

/**
 * Toggle-in-set helper: parses the JSON-encoded string, flips `item`
 * membership, and returns the re-encoded string. Used by every expanded-set
 * setting (hosts, containers, pools, etc.).
 */
export function toggleInSet(raw: string | undefined, item: string): string {
  const set = parseExpandedSet(raw);
  if (set.has(item)) {
    set.delete(item);
  } else {
    set.add(item);
  }
  return JSON.stringify(Array.from(set));
}

import { useSetAtom } from 'jotai';
import { rawSettingsAtom } from './settingsAtom';
import { useMuxQuery } from '@/lib/mux/use-mux-channel';
import { settingsChannel, userSettingsChannel } from '@/lib/channels/settings';
import { isUserSettingsKey } from '@/lib/constants/settings-keys';
import type { SettingsWireMessage } from '@/types/settings';

const EMPTY_SETTINGS: Record<string, string> = {};

type KeyOwner = (key: string) => boolean;

const isGlobalSettingsKey: KeyOwner = (key) => !isUserSettingsKey(key);

/**
 * 'init' replaces the keys `owns` accepts and keeps the rest, 'change' merges one owned key. Both streams fold into
 * one record, so each must leave the other's keys alone.
 */
export function foldSettings(
  prev: Record<string, string>,
  data: SettingsWireMessage,
  owns: KeyOwner = isGlobalSettingsKey,
): Record<string, string> {
  if (data.type === 'change') {
    return owns(data.key) ? { ...prev, [data.key]: data.value } : prev;
  }
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(prev)) {
    if (!owns(key)) next[key] = value;
  }
  for (const [key, value] of Object.entries(data.settings)) {
    if (owns(key)) next[key] = value;
  }
  return next;
}

const foldUserSettings = (prev: Record<string, string>, data: SettingsWireMessage) =>
  foldSettings(prev, data, isUserSettingsKey);

/**
 * Connects the shared server settings and the signed-in user's own settings (both over the WebSocket) to the Jotai
 * atom. Call once near the top of the tree (e.g. AppShell).
 */
export function useSettingsSync(): void {
  const setRaw = useSetAtom(rawSettingsAtom);

  useMuxQuery(
    settingsChannel,
    {
      queryKey: ['settings'],
      initial: EMPTY_SETTINGS,
      fold: (prev, data) => foldSettings(prev, data),
      // The atom stays the consumer surface; the query cache is the stream mirror.
      onData: (data) => {
        setRaw(prev => foldSettings(prev, data));
      },
      // Returns void, but a server-side failure is still worth a console entry.
      onServiceError: () => {
        console.error('[useSettingsSync] Settings stream failed on the server');
      },
    },
  );

  useMuxQuery(
    userSettingsChannel,
    {
      queryKey: ['user-settings'],
      initial: EMPTY_SETTINGS,
      fold: foldUserSettings,
      onData: (data) => {
        setRaw(prev => foldUserSettings(prev, data));
      },
      onServiceError: () => {
        console.error('[useSettingsSync] User settings stream failed on the server');
      },
    },
  );
}

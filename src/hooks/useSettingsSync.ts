import { useSetAtom } from 'jotai';
import { rawSettingsAtom } from './settingsAtom';
import { useMuxQuery } from '@/lib/mux/use-mux-channel';
import { SETTINGS_TOPIC } from '@/lib/mux/protocol';
import { settingsChannel } from '@/lib/sse/channels/settings';
import type { SettingsSSEMessage } from '@/types/settings';

const EMPTY_SETTINGS: Record<string, string> = {};

/** 'init' replaces the record, 'change' merges one key. Shared by the mux fold and the atom write. */
export function foldSettings(
  prev: Record<string, string>,
  data: SettingsSSEMessage,
): Record<string, string> {
  if (data.type === 'init') return data.settings;
  return { ...prev, [data.key]: data.value };
}

/** Connects the settings stream (over the mux) to the Jotai atom ('init' replaces, 'change' merges). Call once near the top of the tree (e.g. AppShell). */
export function useSettingsSync(): void {
  const setRaw = useSetAtom(rawSettingsAtom);

  useMuxQuery(
    { ...settingsChannel, topic: SETTINGS_TOPIC },
    {
      queryKey: ['settings'],
      initial: EMPTY_SETTINGS,
      fold: foldSettings,
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
}

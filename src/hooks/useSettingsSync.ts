import { useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { rawSettingsAtom } from './settingsAtom';
import { useSseChannel } from './useSseChannel';
import { settingsChannel } from '@/lib/sse/channels/settings';
import type { SettingsSSEMessage } from '@/types/settings';

/** Connects the settings SSE stream to the Jotai atom ('init' replaces, 'change' merges). Call once near the top of the tree (e.g. AppShell). */
export function useSettingsSync(): void {
  const setRaw = useSetAtom(rawSettingsAtom);

  const handleData = useCallback((data: SettingsSSEMessage) => {
    if (data.type === 'init') {
      setRaw(data.settings);
    } else if (data.type === 'change') {
      setRaw(prev => ({ ...prev, [data.key]: data.value }));
    }
  }, [setRaw]);

  // Returns void, but a server-side failure is still worth a console entry.
  useSseChannel(settingsChannel, {
    onData: handleData,
    onServiceError: () => {
      console.error('[useSettingsSync] Settings stream failed on the server');
    },
  });
}

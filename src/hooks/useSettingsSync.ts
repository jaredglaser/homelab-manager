import { useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { rawSettingsAtom } from './settingsAtom';
import { useSseChannel } from './useSseChannel';
import { settingsChannel } from '@/lib/sse/channels/settings';
import type { SettingsSSEMessage } from '@/types/settings';

/**
 * Connects the settings SSE stream to the Jotai atom.
 *
 * On connect/reconnect: receives full settings state ('init') and replaces the atom.
 * On change: receives a single key/value ('change') and merges it into the atom.
 *
 * Call this once near the top of the component tree (e.g. AppShell).
 */
export function useSettingsSync(): void {
  const setRaw = useSetAtom(rawSettingsAtom);

  const handleData = useCallback((data: SettingsSSEMessage) => {
    if (data.type === 'init') {
      setRaw(data.settings);
    } else if (data.type === 'change') {
      setRaw(prev => ({ ...prev, [data.key]: data.value }));
    }
  }, [setRaw]);

  // This hook returns void; a server-side failure is still worth a console
  // entry rather than silently going unnoticed. `onServiceError` fires only
  // for the channel's own named error event, not generic connection retries.
  useSseChannel(settingsChannel, {
    onData: handleData,
    onServiceError: () => {
      console.error('[useSettingsSync] Settings stream failed on the server');
    },
  });
}

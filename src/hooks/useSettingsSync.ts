import { useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { rawSettingsAtom } from './settingsAtom';
import { useEventSource } from './useEventSource';
import { apiUrl } from '@/lib/utils/api-url';
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

  const handleServiceError = useCallback(() => {
    console.error('[useSettingsSync] Settings stream failed on the server');
  }, []);

  useEventSource<SettingsSSEMessage>({
    url: apiUrl('/api/settings'),
    onData: handleData,
    onServiceError: handleServiceError,
    errorEventName: 'settings_error',
  });
}

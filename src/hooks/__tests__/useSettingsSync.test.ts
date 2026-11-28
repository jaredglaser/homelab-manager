import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { mockModule } from '@/lib/test/mock-module';
import { FakeMuxConnection } from '@/lib/test/fake-mux';

const fakeMux = new FakeMuxConnection();
mockModule<typeof import('@/lib/mux/mux-connection')>('@/lib/mux/mux-connection', (real) => ({
  ...real,
  muxConnection: fakeMux,
}));

const { useSettingsSync } = await import('../useSettingsSync');
const { rawSettingsAtom } = await import('@/hooks/settingsAtom');
const { createStore, Provider: JotaiProvider, useAtomValue } = await import('jotai');

const SETTINGS_TOPIC = 'settings';
const USER_SETTINGS_TOPIC = 'user-settings';

let queryClient: QueryClient;
let store: ReturnType<typeof createStore>;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(JotaiProvider, { store } as Record<string, unknown>, children),
  );
}

beforeEach(() => {
  fakeMux.subscriptions.clear();
  fakeMux.status = { connected: false, error: null };
  queryClient = new QueryClient();
  store = createStore();
});

function useHarness() {
  useSettingsSync();
  return useAtomValue(rawSettingsAtom);
}

function mountSettings() {
  return renderHook(() => useHarness(), { wrapper });
}

function sendSettings(settings: Record<string, string>) {
  fakeMux.emitWire(SETTINGS_TOPIC, 'data', { type: 'init', settings });
}

function sendChange(key: string, value: string) {
  fakeMux.emitWire(SETTINGS_TOPIC, 'data', { type: 'change', key, value });
}

describe('useSettingsSync', () => {
  it('subscribes to the shared and the per-user settings mux topics on mount', () => {
    mountSettings();
    expect(fakeMux.subscribedTopics().sort()).toEqual([SETTINGS_TOPIC, USER_SETTINGS_TOPIC]);
  });

  it("takes display preferences only from the user's own stream and shared settings only from the shared one", () => {
    const { result } = mountSettings();

    act(() => {
      fakeMux.setStatus({ connected: true, error: null });
      sendSettings({ 'general/updateIntervalMs': '2000', 'general/use12HourTime': 'false' });
      fakeMux.emitWire(USER_SETTINGS_TOPIC, 'data', {
        type: 'init',
        settings: { 'general/use12HourTime': 'true', 'general/updateIntervalMs': '9' },
      });
    });
    expect(result.current).toEqual({ 'general/updateIntervalMs': '2000', 'general/use12HourTime': 'true' });

    act(() => {
      fakeMux.emitWire(USER_SETTINGS_TOPIC, 'data', { type: 'change', key: 'docker/chartWindowSeconds', value: '600' });
      sendChange('docker/chartWindowSeconds', '60');
    });
    expect(result.current['docker/chartWindowSeconds']).toBe('600');

    act(() => { sendSettings({ 'general/updateIntervalMs': '5000' }); });
    expect(result.current).toEqual({
      'general/updateIntervalMs': '5000',
      'general/use12HourTime': 'true',
      'docker/chartWindowSeconds': '600',
    });
    act(() => { fakeMux.emitWire(USER_SETTINGS_TOPIC, 'data', { type: 'init', settings: {} }); });
    expect(result.current).toEqual({ 'general/updateIntervalMs': '5000' });
  });

  it('replaces all settings on init and merges single keys on change', () => {
    const { result } = mountSettings();

    act(() => {
      fakeMux.setStatus({ connected: true, error: null });
      sendSettings({ a: '1', b: '2' });
    });
    expect(result.current).toEqual({ a: '1', b: '2' });

    act(() => { sendChange('b', '3'); });
    expect(result.current).toEqual({ a: '1', b: '3' });
  });

  it('folds the stream into the TanStack query cache under the settings key', () => {
    mountSettings();
    act(() => {
      sendSettings({ a: '1' });
      sendChange('b', '2');
    });
    expect(queryClient.getQueryData<Record<string, string>>(['settings'])).toEqual({ a: '1', b: '2' });
  });

  it('a re-delivered init after reconnect replaces state with the server copy', () => {
    const { result } = mountSettings();

    act(() => {
      fakeMux.setStatus({ connected: true, error: null });
      sendSettings({ a: '1', b: '2' });
      sendChange('b', '3');
    });
    expect(result.current).toEqual({ a: '1', b: '3' });

    // Reconnect: the server re-delivers init per subscriber; it must win over prior deltas.
    act(() => {
      fakeMux.setStatus({ connected: false, error: null });
      fakeMux.setStatus({ connected: true, error: null });
      sendSettings({ a: '1', b: '2' });
    });
    expect(result.current).toEqual({ a: '1', b: '2' });
  });

  it('logs service error frames from the server', () => {
    const origError = console.error;
    const errorMock = mock((..._args: unknown[]) => {});
    console.error = errorMock;

    try {
      mountSettings();
      act(() => { fakeMux.setStatus({ connected: true, error: null }); });
      act(() => { fakeMux.emit(SETTINGS_TOPIC, 'error', { message: 'boom' }); });

      expect(errorMock).toHaveBeenCalledWith('[useSettingsSync] Settings stream failed on the server');
    } finally {
      console.error = origError;
    }
  });

  it('unsubscribes from the mux on unmount', () => {
    const { unmount } = mountSettings();
    expect(fakeMux.subscriptionCount(SETTINGS_TOPIC)).toBe(1);
    expect(fakeMux.subscriptionCount(USER_SETTINGS_TOPIC)).toBe(1);
    unmount();
    expect(fakeMux.subscriptionCount(SETTINGS_TOPIC)).toBe(0);
    expect(fakeMux.subscriptionCount(USER_SETTINGS_TOPIC)).toBe(0);
  });
});

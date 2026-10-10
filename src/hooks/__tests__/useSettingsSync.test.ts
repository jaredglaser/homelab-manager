import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { mockModule } from '@/lib/test/mock-module';
import { FakeMuxConnection } from '@/lib/test/fake-mux';
import { MockEventSource } from '@/lib/test/mock-event-source';

const fakeMux = new FakeMuxConnection();
mockModule<typeof import('@/lib/mux/mux-connection')>('@/lib/mux/mux-connection', (real) => ({
  ...real,
  muxConnection: fakeMux,
}));

const { useSettingsSync } = await import('../useSettingsSync');
const { rawSettingsAtom } = await import('../settingsAtom');
const { createStore, Provider: JotaiProvider, useAtomValue } = await import('jotai');

const SETTINGS_TOPIC = 'settings';
const originalEventSource = globalThis.EventSource;

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
  MockEventSource.reset();
  (globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).EventSource = originalEventSource;
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
  it('subscribes to the settings mux topic and opens no EventSource', () => {
    mountSettings();
    expect(fakeMux.subscribedTopics()).toEqual([SETTINGS_TOPIC]);
    expect(MockEventSource.instances).toHaveLength(0);
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
    unmount();
    expect(fakeMux.subscriptionCount(SETTINGS_TOPIC)).toBe(0);
  });
});

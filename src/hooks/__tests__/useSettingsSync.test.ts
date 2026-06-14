import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useAtomValue } from 'jotai';
import { MockEventSource } from '@/lib/test/mock-event-source';
import { useSettingsSync } from '../useSettingsSync';
import { rawSettingsAtom } from '../settingsAtom';

const originalEventSource = globalThis.EventSource;

beforeEach(() => {
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

describe('useSettingsSync', () => {
  it('subscribes to /api/settings EventSource', () => {
    renderHook(() => useHarness());
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe('/api/settings');
  });

  it('replaces all settings on init and merges single keys on change', () => {
    const { result } = renderHook(() => useHarness());
    const es = MockEventSource.instances[0];

    act(() => {
      es.onopen?.();
      es.onmessage?.({ data: JSON.stringify({ type: 'init', settings: { a: '1', b: '2' } }) });
    });
    expect(result.current).toEqual({ a: '1', b: '2' });

    act(() => {
      es.onmessage?.({ data: JSON.stringify({ type: 'change', key: 'b', value: '3' }) });
    });
    expect(result.current).toEqual({ a: '1', b: '3' });
  });

  it('logs settings_error events from the server', () => {
    const origError = console.error;
    const errorMock = mock((..._args: unknown[]) => {});
    console.error = errorMock;

    try {
      renderHook(() => useHarness());
      const es = MockEventSource.instances[0];

      act(() => { es.onopen?.(); });
      act(() => { es.fireEvent('settings_error'); });

      expect(errorMock).toHaveBeenCalledWith('[useSettingsSync] Settings stream failed on the server');
    } finally {
      console.error = origError;
    }
  });
});

import { describe, expect, it, beforeEach, spyOn } from 'bun:test';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { mockModule } from '@/lib/test/mock-module';

const muxState: { onData: ((data: unknown) => void) | null } = { onData: null };
const toastLog: Array<{ message: string; severity: string }> = [];

mockModule<typeof import('@/lib/mux/use-mux-channel')>('@/lib/mux/use-mux-channel', (real) => ({
  ...real,
  useMuxChannel: (_channel: unknown, options: { onData: (data: unknown) => void }) => {
    muxState.onData = options.onData;
    return { isConnected: true, error: null };
  },
}));

mockModule<typeof import('@/hooks/toastAtom')>('@/hooks/toastAtom', (real) => ({
  ...real,
  useToast: () => ({
    showToast: (message: string, severity: string) => {
      toastLog.push({ message, severity });
    },
  }),
}));

import { useImageUpdateAlerts, updateToastMessage } from '../useImageUpdateAlerts';

describe('updateToastMessage', () => {
  it('names the new tag when the check found one', () => {
    expect(updateToastMessage('redis:7', '7.4.2')).toBe('Update available for redis:7: 7.4.2');
  });

  it('stays versionless for floating tags', () => {
    expect(updateToastMessage('myapp:latest', null)).toBe('Update available for myapp:latest');
  });
});

describe('useImageUpdateAlerts', () => {
  beforeEach(() => {
    toastLog.length = 0;
    muxState.onData = null;
  });

  it('toasts on a new update and invalidates the panel query', () => {
    const client = new QueryClient();
    const invalidateSpy = spyOn(client, 'invalidateQueries').mockResolvedValue(undefined);
    const wrap = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client }, children);
    renderHook(() => useImageUpdateAlerts(), { wrapper: wrap });

    expect(muxState.onData).not.toBeNull();
    muxState.onData!({
      type: 'updates_changed',
      stack: 'web',
      host: 'host1',
      image: 'redis:7',
      update_available: true,
      latest_matching_tag: '7.4.2',
      checked_at: '2026-01-03T00:00:00.000Z',
    });

    expect(toastLog).toEqual([{ message: 'Update available for redis:7: 7.4.2', severity: 'info' }]);
    expect(invalidateSpy).toHaveBeenCalled();
    const arg = invalidateSpy.mock.calls[0][0] as { queryKey: unknown[] };
    expect(arg.queryKey[0]).toBe('image-update-info');
    invalidateSpy.mockRestore();
  });

  it('invalidates without toasting when the update state moved away from available', () => {
    const client = new QueryClient();
    const invalidateSpy = spyOn(client, 'invalidateQueries').mockResolvedValue(undefined);
    const wrap = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client }, children);
    renderHook(() => useImageUpdateAlerts(), { wrapper: wrap });

    muxState.onData!({
      type: 'updates_changed',
      stack: 'web',
      host: 'host1',
      image: 'redis:7',
      update_available: false,
      latest_matching_tag: null,
      checked_at: '2026-01-03T00:00:00.000Z',
    });

    expect(toastLog).toHaveLength(0);
    expect(invalidateSpy).toHaveBeenCalled();
    invalidateSpy.mockRestore();
  });
});

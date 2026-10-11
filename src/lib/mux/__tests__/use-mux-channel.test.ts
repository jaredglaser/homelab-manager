import { describe, it, expect, beforeEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { z } from 'zod';
import { mockModule } from '@/lib/test/mock-module';
import { FakeMuxConnection } from '@/lib/test/fake-mux';

const fakeMux = new FakeMuxConnection();
mockModule<typeof import('@/lib/mux/mux-connection')>('@/lib/mux/mux-connection', (real) => ({
  ...real,
  muxConnection: fakeMux,
}));

import { useMuxChannel } from '@/lib/mux/use-mux-channel';

const channel = { topic: 'inventory', schema: z.object({ n: z.number() }) };

beforeEach(() => {
  fakeMux.subscriptions.clear();
  fakeMux.status = { connected: false, error: null };
});

describe('useMuxChannel subscribe rejections', () => {
  it('exposes the rejection message as the channel error state', () => {
    const { result } = renderHook(() => useMuxChannel(channel, { onData: () => {} }));

    act(() => {
      fakeMux.emitSubscribeRejected('inventory', {
        code: 'topic_limit',
        message: 'Session topic limit (250) reached. Unsubscribe unused topics.',
      });
    });

    expect(result.current.error?.message).toBe('Session topic limit (250) reached. Unsubscribe unused topics.');
  });

  it('clears the rejection error once the connection recovers', () => {
    const { result } = renderHook(() => useMuxChannel(channel, { onData: () => {} }));

    act(() => {
      fakeMux.emitSubscribeRejected('inventory', { code: 'topic_limit', message: 'rejected' });
    });
    expect(result.current.error).not.toBeNull();

    act(() => {
      fakeMux.setStatus({ connected: true, error: null });
    });
    expect(result.current.error).toBeNull();
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { MockEventSource } from '@/lib/test/mock-event-source';
import { useAiAnalysis } from '@/hooks/useAiAnalysis';

const originalEventSource = globalThis.EventSource;

const snapshotFrame = {
  profiles: [],
  sessions: [],
  observations: [
    {
      id: 1,
      sessionId: 'session-1',
      host: 'nuc',
      containerKey: 'media/plex',
      at: '2026-08-14T10:00:00.000Z',
      severity: 'warning',
      title: 'Transcode failures',
      detail: 'Four in a row',
      evidence: [],
      triaged: false,
    },
  ],
  alerts: [],
};

beforeEach(() => {
  MockEventSource.reset();
  (globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).EventSource = originalEventSource;
});

describe('useAiAnalysis', () => {
  it('subscribes to the AI analysis channel', () => {
    renderHook(() => useAiAnalysis());
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe('/api/ai-analysis');
  });

  it('starts empty and loading', () => {
    const { result } = renderHook(() => useAiAnalysis());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.snapshot.observations).toEqual([]);
  });

  it('replaces state with each snapshot and revives its dates', () => {
    const { result } = renderHook(() => useAiAnalysis());
    const source = MockEventSource.instances[0];

    act(() => {
      source.onmessage?.({ data: JSON.stringify(snapshotFrame) });
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.snapshot.observations).toHaveLength(1);
    expect(result.current.snapshot.observations[0].at).toBeInstanceOf(Date);

    act(() => {
      source.onmessage?.({ data: JSON.stringify({ ...snapshotFrame, observations: [] }) });
    });

    expect(result.current.snapshot.observations).toEqual([]);
  });

  it('surfaces the server-side error event', () => {
    const { result } = renderHook(() => useAiAnalysis());
    const source = MockEventSource.instances[0];

    act(() => {
      source.fireEvent('ai_analysis_error', { data: JSON.stringify({ message: 'db down' }) });
    });

    expect(result.current.error?.message).toBe('AI analysis stream unavailable');
  });
});

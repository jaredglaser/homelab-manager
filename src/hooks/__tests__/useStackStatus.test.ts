import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { MockEventSource } from '@/lib/test/mock-event-source';

const mockShowToast = mock((_message: string, _severity: string) => {});
mock.module('@/hooks/toastAtom', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}));

const { useStackStatus } = await import('@/hooks/useStackStatus');

const originalEventSource = globalThis.EventSource;

beforeEach(() => {
  MockEventSource.reset();
  mockShowToast.mockClear();
  (globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).EventSource = originalEventSource;
});

describe('useStackStatus', () => {
  it('subscribes to /api/stack-status EventSource', () => {
    renderHook(() => useStackStatus());
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe('/api/stack-status');
  });

  it('starts with empty statusMap and deployVersion 0', () => {
    const { result } = renderHook(() => useStackStatus());
    expect(result.current.statusMap.size).toBe(0);
    expect(result.current.deployVersion).toBe(0);
  });

  it('parses SSE data into Map keyed by host/stack', () => {
    const { result } = renderHook(() => useStackStatus());
    const es = MockEventSource.instances[0];

    act(() => {
      es.onopen?.();
      es.onmessage?.({
        data: JSON.stringify([
          { stack: 'plex', host: 'server1', containers: [{ id: 'abc', name: 'plex', status: 'running', image: 'plexinc/pms-docker', service: null }], updated_at: '2026-03-21T00:00:00Z' },
          { stack: 'traefik', host: 'server1', containers: [], updated_at: '2026-03-21T00:00:00Z' },
        ]),
      });
    });

    expect(result.current.statusMap.size).toBe(2);
    expect(result.current.statusMap.has('server1/plex')).toBe(true);
    expect(result.current.statusMap.has('server1/traefik')).toBe(true);
  });

  it('increments deployVersion on deploy_changed messages', () => {
    const { result } = renderHook(() => useStackStatus());
    const es = MockEventSource.instances[0];

    act(() => {
      es.onopen?.();
      es.onmessage?.({
        data: JSON.stringify({ type: 'deploy_changed', stack: 'plex', host: 'server1' }),
      });
    });

    expect(result.current.deployVersion).toBe(1);
  });

  it('legacy deploy_changed payload without outcome fields bumps version but never toasts', () => {
    const { result } = renderHook(() => useStackStatus());
    const es = MockEventSource.instances[0];

    act(() => {
      es.onopen?.();
      es.onmessage?.({
        data: JSON.stringify({ type: 'deploy_changed', stack: 'plex', host: 'server1' }),
      });
    });

    expect(result.current.deployVersion).toBe(1);
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it('toasts once for a terminal deploy_changed outcome carrying a deployId', () => {
    const { result } = renderHook(() => useStackStatus());
    const es = MockEventSource.instances[0];

    act(() => {
      es.onopen?.();
      es.onmessage?.({
        data: JSON.stringify({
          type: 'deploy_changed',
          stack: 'plex',
          host: 'server1',
          outcome: { deployId: 101, status: 'succeeded', action: 'deploy', trigger: 'ui' },
        }),
      });
    });

    expect(result.current.deployVersion).toBe(1);
    expect(mockShowToast).toHaveBeenCalledTimes(1);
    expect(mockShowToast).toHaveBeenCalledWith('Deploy of plex succeeded', 'success');
  });

  it('toasts a failed outcome with the sanitized message', () => {
    const { result } = renderHook(() => useStackStatus());
    const es = MockEventSource.instances[0];

    act(() => {
      es.onopen?.();
      es.onmessage?.({
        data: JSON.stringify({
          type: 'deploy_changed',
          stack: 'plex',
          host: 'server1',
          outcome: { deployId: 102, status: 'failed', action: 'deploy', trigger: 'git_push', message: 'image not found' },
        }),
      });
    });

    expect(result.current.deployVersion).toBe(1);
    expect(mockShowToast).toHaveBeenCalledWith('Deploy of plex (git push) failed: image not found', 'error');
  });

  it('drops a frame whose outcome is missing a required field: no version bump, no toast', () => {
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderHook(() => useStackStatus());
    const es = MockEventSource.instances[0];

    act(() => {
      es.onopen?.();
      es.onmessage?.({
        data: JSON.stringify({
          type: 'deploy_changed',
          stack: 'plex',
          host: 'server1',
          outcome: { deployId: 104, status: 'failed', action: 'deploy' },
        }),
      });
    });

    expect(result.current.deployVersion).toBe(0);
    expect(mockShowToast).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('toasts a duplicate deployId only once, even across separate SSE messages', () => {
    const { result } = renderHook(() => useStackStatus());
    const es = MockEventSource.instances[0];

    const frame = JSON.stringify({
      type: 'deploy_changed',
      stack: 'plex',
      host: 'server1',
      outcome: { deployId: 103, status: 'succeeded', action: 'deploy', trigger: 'ui' },
    });

    act(() => {
      es.onopen?.();
      es.onmessage?.({ data: frame });
      es.onmessage?.({ data: frame });
    });

    expect(result.current.deployVersion).toBe(2);
    expect(mockShowToast).toHaveBeenCalledTimes(1);
  });

  it('a non-terminal outcome does not consume the gate, so the later terminal outcome still toasts', () => {
    const { result } = renderHook(() => useStackStatus());
    const es = MockEventSource.instances[0];

    const pending = JSON.stringify({
      type: 'deploy_changed',
      stack: 'plex',
      host: 'server1',
      outcome: { deployId: 200, status: 'in_progress', action: 'deploy', trigger: 'ui' },
    });
    const succeeded = JSON.stringify({
      type: 'deploy_changed',
      stack: 'plex',
      host: 'server1',
      outcome: { deployId: 200, status: 'succeeded', action: 'deploy', trigger: 'ui' },
    });

    act(() => {
      es.onopen?.();
      es.onmessage?.({ data: pending });
      es.onmessage?.({ data: succeeded });
    });

    expect(result.current.deployVersion).toBe(2);
    expect(mockShowToast).toHaveBeenCalledTimes(1);
    expect(mockShowToast).toHaveBeenCalledWith('Deploy of plex succeeded', 'success');
  });

  it('never toasts for the init status-entries array', () => {
    const { result } = renderHook(() => useStackStatus());
    const es = MockEventSource.instances[0];

    act(() => {
      es.onopen?.();
      es.onmessage?.({
        data: JSON.stringify([
          { stack: 'plex', host: 'server1', containers: [], updated_at: '2026-03-21T00:00:00Z' },
        ]),
      });
    });

    expect(result.current.statusMap.size).toBe(1);
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it('does not create a new Map when container data is unchanged', () => {
    const { result } = renderHook(() => useStackStatus());
    const es = MockEventSource.instances[0];

    const entry = [{ stack: 'plex', host: 'server1', containers: [{ id: 'a', name: 'plex', status: 'running', image: 'img', service: null }], updated_at: '2026-03-21T00:00:00Z' }];

    act(() => {
      es.onopen?.();
      es.onmessage?.({ data: JSON.stringify(entry) });
    });

    const firstMap = result.current.statusMap;

    act(() => {
      es.onmessage?.({ data: JSON.stringify(entry) });
    });

    expect(result.current.statusMap).toBe(firstMap);
  });

  it('creates a new Map when container data changes', () => {
    const { result } = renderHook(() => useStackStatus());
    const es = MockEventSource.instances[0];

    act(() => {
      es.onopen?.();
      es.onmessage?.({
        data: JSON.stringify([{ stack: 'plex', host: 'server1', containers: [{ id: 'a', name: 'plex', status: 'running', image: 'img', service: null }], updated_at: '2026-03-21T00:00:00Z' }]),
      });
    });

    const firstMap = result.current.statusMap;

    act(() => {
      es.onmessage?.({
        data: JSON.stringify([{ stack: 'plex', host: 'server1', containers: [{ id: 'a', name: 'plex', status: 'exited', image: 'img', service: null }], updated_at: '2026-03-21T00:00:01Z' }]),
      });
    });

    expect(result.current.statusMap).not.toBe(firstMap);
    expect(result.current.statusMap.get('server1/plex')?.containers[0].status).toBe('exited');
  });

  it('uses host/stack composite key for multiple hosts', () => {
    const { result } = renderHook(() => useStackStatus());
    const es = MockEventSource.instances[0];

    act(() => {
      es.onopen?.();
      es.onmessage?.({
        data: JSON.stringify([
          { stack: 'plex', host: 'server1', containers: [], updated_at: '2026-03-21T00:00:00Z' },
          { stack: 'plex', host: 'server2', containers: [], updated_at: '2026-03-21T00:00:00Z' },
        ]),
      });
    });

    expect(result.current.statusMap.size).toBe(2);
    expect(result.current.statusMap.has('server1/plex')).toBe(true);
    expect(result.current.statusMap.has('server2/plex')).toBe(true);
  });

  it('surfaces stack_status_error events and clears the error on next data', () => {
    const { result } = renderHook(() => useStackStatus());
    const es = MockEventSource.instances[0];

    act(() => { es.onopen?.(); });
    act(() => { es.fireEvent('stack_status_error'); });

    expect(result.current.error).toBe('Stack status stream unavailable');

    act(() => {
      es.onmessage?.({
        data: JSON.stringify([{ stack: 'plex', host: 'server1', containers: [], updated_at: '2026-03-21T00:00:00Z' }]),
      });
    });

    expect(result.current.error).toBeNull();
  });

  it('cleans up EventSource on unmount', () => {
    const { unmount } = renderHook(() => useStackStatus());
    const es = MockEventSource.instances[0];
    expect(es.closed).toBe(false);
    unmount();
    expect(es.closed).toBe(true);
  });
});

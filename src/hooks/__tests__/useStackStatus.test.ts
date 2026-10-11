import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { mockModule } from '@/lib/test/mock-module';
import { FakeMuxConnection } from '@/lib/test/fake-mux';
import { MockEventSource } from '@/lib/test/mock-event-source';

const mockShowToast = mock((_message: string, _severity: string) => {});
mockModule<typeof import('@/hooks/toastAtom')>('@/hooks/toastAtom', (real) => ({ ...real, 
  useToast: () => ({ showToast: mockShowToast }),
}));

const fakeMux = new FakeMuxConnection();
mockModule<typeof import('@/lib/mux/mux-connection')>('@/lib/mux/mux-connection', (real) => ({
  ...real,
  muxConnection: fakeMux,
}));

const { useStackStatus } = await import('@/hooks/useStackStatus');

const STACK_STATUS_TOPIC = 'stack-status';
const originalEventSource = globalThis.EventSource;

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

beforeEach(() => {
  fakeMux.subscriptions.clear();
  fakeMux.status = { connected: false, error: null };
  queryClient = new QueryClient();
  mockShowToast.mockClear();
  MockEventSource.reset();
  (globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).EventSource = originalEventSource;
});

function mountStackStatus() {
  return renderHook(() => useStackStatus(), { wrapper });
}

function sendEntries(entries: unknown[]) {
  fakeMux.emitWire(STACK_STATUS_TOPIC, 'data', entries);
}

function sendDeployChanged(payload: unknown) {
  fakeMux.emitWire(STACK_STATUS_TOPIC, 'data', payload);
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    stack: 'plex',
    host: 'server1',
    containers: [{ id: 'abc', name: 'plex', status: 'running', image: 'plexinc/pms-docker', service: null }],
    updated_at: '2026-03-21T00:00:00Z',
    ...overrides,
  };
}

describe('useStackStatus', () => {
  it('subscribes to the stack-status mux topic and opens no EventSource', () => {
    mountStackStatus();
    expect(fakeMux.subscribedTopics()).toEqual([STACK_STATUS_TOPIC]);
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('starts with empty statusMap and deployVersion 0', () => {
    const { result } = mountStackStatus();
    expect(result.current.statusMap.size).toBe(0);
    expect(result.current.deployVersion).toBe(0);
  });

  it('parses frames into Map keyed by host/stack', () => {
    const { result } = mountStackStatus();

    act(() => {
      fakeMux.setStatus({ connected: true, error: null });
      sendEntries([
        entry(),
        { stack: 'traefik', host: 'server1', containers: [], updated_at: '2026-03-21T00:00:00Z' },
      ]);
    });

    expect(result.current.statusMap.size).toBe(2);
    expect(result.current.statusMap.has('server1/plex')).toBe(true);
    expect(result.current.statusMap.has('server1/traefik')).toBe(true);
  });

  it('increments deployVersion on deploy_changed messages', () => {
    const { result } = mountStackStatus();

    act(() => {
      fakeMux.setStatus({ connected: true, error: null });
      sendDeployChanged({ type: 'deploy_changed', stack: 'plex', host: 'server1' });
    });

    expect(result.current.deployVersion).toBe(1);
  });

  it('legacy deploy_changed payload without outcome fields bumps version but never toasts', () => {
    const { result } = mountStackStatus();

    act(() => {
      fakeMux.setStatus({ connected: true, error: null });
      sendDeployChanged({ type: 'deploy_changed', stack: 'plex', host: 'server1' });
    });

    expect(result.current.deployVersion).toBe(1);
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it('toasts once for a terminal deploy_changed outcome carrying a deployId', () => {
    const { result } = mountStackStatus();

    act(() => {
      fakeMux.setStatus({ connected: true, error: null });
      sendDeployChanged({
        type: 'deploy_changed',
        stack: 'plex',
        host: 'server1',
        outcome: { deployId: 101, status: 'succeeded', action: 'deploy', trigger: 'ui' },
      });
    });

    expect(result.current.deployVersion).toBe(1);
    expect(mockShowToast).toHaveBeenCalledTimes(1);
    expect(mockShowToast).toHaveBeenCalledWith('Deploy of server1/plex succeeded', 'success');
  });

  it('toasts the host from the stream frame, not a cached default', () => {
    mountStackStatus();

    act(() => {
      fakeMux.setStatus({ connected: true, error: null });
      sendDeployChanged({
        type: 'deploy_changed',
        stack: 'plex',
        host: 'server2',
        outcome: { deployId: 106, status: 'succeeded', action: 'deploy', trigger: 'ui' },
      });
    });

    expect(mockShowToast).toHaveBeenCalledWith('Deploy of server2/plex succeeded', 'success');
  });

  it('toasts the no_change ui-trigger outcome as an info with host/stack', () => {
    mountStackStatus();

    act(() => {
      fakeMux.setStatus({ connected: true, error: null });
      sendDeployChanged({
        type: 'deploy_changed',
        stack: 'plex',
        host: 'server1',
        outcome: { deployId: 105, status: 'no_change', action: 'deploy', trigger: 'ui' },
      });
    });

    expect(mockShowToast).toHaveBeenCalledWith('No changes detected for server1/plex', 'info');
  });

  it('toasts a failed outcome with the sanitized message', () => {
    const { result } = mountStackStatus();

    act(() => {
      fakeMux.setStatus({ connected: true, error: null });
      sendDeployChanged({
        type: 'deploy_changed',
        stack: 'plex',
        host: 'server1',
        outcome: { deployId: 102, status: 'failed', action: 'deploy', trigger: 'git_push', message: 'image not found' },
      });
    });

    expect(result.current.deployVersion).toBe(1);
    expect(mockShowToast).toHaveBeenCalledWith('Deploy of server1/plex (git push) failed: image not found', 'error');
  });

  it('drops a frame whose outcome is missing a required field: no version bump, no toast', () => {
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const { result } = mountStackStatus();

    act(() => {
      fakeMux.setStatus({ connected: true, error: null });
      sendDeployChanged({
        type: 'deploy_changed',
        stack: 'plex',
        host: 'server1',
        outcome: { deployId: 104, status: 'failed', action: 'deploy' },
      });
    });

    expect(result.current.deployVersion).toBe(0);
    expect(mockShowToast).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('toasts a duplicate deployId only once, even across separate frames', () => {
    const { result } = mountStackStatus();
    const frame = {
      type: 'deploy_changed',
      stack: 'plex',
      host: 'server1',
      outcome: { deployId: 103, status: 'succeeded', action: 'deploy', trigger: 'ui' },
    };

    act(() => {
      fakeMux.setStatus({ connected: true, error: null });
      sendDeployChanged(frame);
      sendDeployChanged(frame);
    });

    expect(result.current.deployVersion).toBe(2);
    expect(mockShowToast).toHaveBeenCalledTimes(1);
  });

  it('a non-terminal outcome does not consume the gate, so the later terminal outcome still toasts', () => {
    const { result } = mountStackStatus();

    act(() => {
      fakeMux.setStatus({ connected: true, error: null });
      sendDeployChanged({
        type: 'deploy_changed',
        stack: 'plex',
        host: 'server1',
        outcome: { deployId: 200, status: 'in_progress', action: 'deploy', trigger: 'ui' },
      });
      sendDeployChanged({
        type: 'deploy_changed',
        stack: 'plex',
        host: 'server1',
        outcome: { deployId: 200, status: 'succeeded', action: 'deploy', trigger: 'ui' },
      });
    });

    expect(result.current.deployVersion).toBe(2);
    expect(mockShowToast).toHaveBeenCalledTimes(1);
    expect(mockShowToast).toHaveBeenCalledWith('Deploy of server1/plex succeeded', 'success');
  });

  it('never toasts for the status-entries array', () => {
    const { result } = mountStackStatus();

    act(() => {
      fakeMux.setStatus({ connected: true, error: null });
      sendEntries([entry({ containers: [] })]);
    });

    expect(result.current.statusMap.size).toBe(1);
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it('does not create a new Map when container data is unchanged', () => {
    const { result } = mountStackStatus();
    const payload = [entry({ containers: [{ id: 'a', name: 'plex', status: 'running', image: 'img', service: null }] })];

    act(() => {
      fakeMux.setStatus({ connected: true, error: null });
      sendEntries(payload);
    });

    const firstMap = result.current.statusMap;
    act(() => { sendEntries(payload); });

    expect(result.current.statusMap).toBe(firstMap);
  });

  it('creates a new Map when container data changes', () => {
    const { result } = mountStackStatus();

    act(() => {
      fakeMux.setStatus({ connected: true, error: null });
      sendEntries([entry({ containers: [{ id: 'a', name: 'plex', status: 'running', image: 'img', service: null }] })]);
    });

    const firstMap = result.current.statusMap;
    act(() => {
      sendEntries([entry({
        containers: [{ id: 'a', name: 'plex', status: 'exited', image: 'img', service: null }],
        updated_at: '2026-03-21T00:00:01Z',
      })]);
    });

    expect(result.current.statusMap).not.toBe(firstMap);
    expect(result.current.statusMap.get('server1/plex')?.containers[0].status).toBe('exited');
  });

  it('uses host/stack composite key for multiple hosts', () => {
    const { result } = mountStackStatus();

    act(() => {
      fakeMux.setStatus({ connected: true, error: null });
      sendEntries([
        entry({ containers: [] }),
        entry({ host: 'server2', containers: [] }),
      ]);
    });

    expect(result.current.statusMap.size).toBe(2);
    expect(result.current.statusMap.has('server1/plex')).toBe(true);
    expect(result.current.statusMap.has('server2/plex')).toBe(true);
  });

  it('converges on the server state when init is re-delivered after a reconnect', () => {
    const { result } = mountStackStatus();

    act(() => {
      fakeMux.setStatus({ connected: true, error: null });
      sendEntries([entry({ containers: [{ id: 'a', name: 'plex', status: 'running', image: 'img', service: null }] })]);
    });
    expect(result.current.statusMap.get('server1/plex')?.containers[0].status).toBe('running');

    // Reconnect: the server re-delivers init per subscriber and it must win over prior state.
    act(() => {
      fakeMux.setStatus({ connected: false, error: null });
      fakeMux.setStatus({ connected: true, error: null });
      sendEntries([entry({ containers: [{ id: 'a', name: 'plex', status: 'exited', image: 'img', service: null }] })]);
    });

    expect(result.current.statusMap.get('server1/plex')?.containers[0].status).toBe('exited');
  });

  it('surfaces error frames and clears the error on next data', () => {
    const { result } = mountStackStatus();

    act(() => { fakeMux.setStatus({ connected: true, error: null }); });
    act(() => { fakeMux.emit(STACK_STATUS_TOPIC, 'error', { message: 'boom' }); });

    expect(result.current.error).toBe('Stack status stream unavailable');

    act(() => { sendEntries([entry({ containers: [] })]); });
    expect(result.current.error).toBeNull();
  });

  it('unsubscribes from the mux on unmount', () => {
    const { unmount } = mountStackStatus();
    expect(fakeMux.subscriptionCount(STACK_STATUS_TOPIC)).toBe(1);
    unmount();
    expect(fakeMux.subscriptionCount(STACK_STATUS_TOPIC)).toBe(0);
  });
});

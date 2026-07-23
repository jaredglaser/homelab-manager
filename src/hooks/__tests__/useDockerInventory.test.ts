import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { MockEventSource } from '@/lib/test/mock-event-source';
import { useDockerInventory, mergeUpsert } from '../useDockerInventory';
import type {
  DockerInventoryBroadcastEvent,
  DockerInventorySnapshotContainer,
  DockerInventoryUpdateContainer,
} from '@/types/docker-inventory';

const originalEventSource = globalThis.EventSource;

beforeEach(() => {
  MockEventSource.reset();
  (globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).EventSource = originalEventSource;
});

function sendEvent(es: MockEventSource, event: DockerInventoryBroadcastEvent) {
  es.onmessage?.({ data: JSON.stringify(event) });
}

describe('useDockerInventory', () => {
  it('subscribes to /api/docker-inventory EventSource on mount', () => {
    renderHook(() => useDockerInventory());
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe('/api/docker-inventory');
  });

  it('starts with empty inventory and disconnected state', () => {
    const { result } = renderHook(() => useDockerInventory());
    expect(result.current.inventory.size).toBe(0);
    expect(result.current.isConnected).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('sets isConnected true on open', () => {
    const { result } = renderHook(() => useDockerInventory());
    const es = MockEventSource.instances[0];

    act(() => { es.onopen?.(); });

    expect(result.current.isConnected).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('populates inventory map from init event', () => {
    const { result } = renderHook(() => useDockerInventory());
    const es = MockEventSource.instances[0];

    act(() => {
      es.onopen?.();
      sendEvent(es, {
        type: 'init',
        containers: [
          {
            host: 'server1',
            containerId: 'abc123',
            name: 'plex',
            image: 'plexinc/pms-docker:latest',
            state: 'running',
            composeProject: 'media',
            serviceKey: 'media/plex',
            startedAt: new Date('2026-04-16T10:00:00Z'),
            finishedAt: null,
            exitCode: null,
            labels: { 'com.docker.compose.project': 'media' },
            ports: [{ containerPort: 32400, protocol: 'tcp', hostIp: null, hostPort: 32400 }],
            mounts: [{ type: 'volume', source: 'plex-config', destination: '/config', rw: true }],
            updatedAt: new Date('2026-04-16T10:00:00Z'),
          },
        ],
      });
    });

    expect(result.current.inventory.size).toBe(1);
    expect(result.current.inventory.has('server1/abc123')).toBe(true);
    expect(result.current.inventory.get('server1/abc123')?.name).toBe('plex');
  });

  it('rehydrates date fields to Date objects on init (SSE delivers ISO strings)', () => {
    const { result } = renderHook(() => useDockerInventory());
    const es = MockEventSource.instances[0];

    act(() => {
      es.onopen?.();
      sendEvent(es, {
        type: 'init',
        containers: [
          {
            host: 'server1',
            containerId: 'abc123',
            name: 'plex',
            image: 'img',
            state: 'exited',
            composeProject: null,
            serviceKey: '',
            startedAt: new Date('2026-04-16T10:00:00Z'),
            finishedAt: new Date('2026-04-16T11:00:00Z'),
            exitCode: 0,
            labels: {},
            ports: [],
            mounts: [],
            updatedAt: new Date('2026-04-16T11:00:00Z'),
          },
        ],
      });
    });

    const entry = result.current.inventory.get('server1/abc123')!;
    expect(entry.startedAt).toBeInstanceOf(Date);
    expect(entry.finishedAt).toBeInstanceOf(Date);
    expect(entry.updatedAt).toBeInstanceOf(Date);
    expect(entry.startedAt!.getTime()).toBe(Date.parse('2026-04-16T10:00:00Z'));
    expect(entry.updatedAt.getTime()).toBe(Date.parse('2026-04-16T11:00:00Z'));
  });

  it('rehydrates date fields to Date objects on upsert', () => {
    const { result } = renderHook(() => useDockerInventory());
    const es = MockEventSource.instances[0];

    act(() => {
      es.onopen?.();
      sendEvent(es, { type: 'init', containers: [] });
      sendEvent(es, {
        type: 'upsert',
        container: {
          host: 'server1',
          containerId: 'abc123',
          name: 'plex',
          image: 'img',
          state: 'running',
          composeProject: null,
          serviceKey: '',
          startedAt: new Date('2026-04-16T10:00:00Z'),
          finishedAt: null,
          exitCode: null,
          ports: [],
          updatedAt: new Date('2026-04-16T10:00:00Z'),
        },
      });
    });

    const entry = result.current.inventory.get('server1/abc123')!;
    expect(entry.startedAt).toBeInstanceOf(Date);
    expect(entry.updatedAt).toBeInstanceOf(Date);
    expect(entry.startedAt!.getTime()).toBe(Date.parse('2026-04-16T10:00:00Z'));
  });

  it('replaces entire inventory on second init event', () => {
    const { result } = renderHook(() => useDockerInventory());
    const es = MockEventSource.instances[0];

    act(() => {
      es.onopen?.();
      sendEvent(es, {
        type: 'init',
        containers: [
          {
            host: 'server1',
            containerId: 'abc123',
            name: 'plex',
            image: 'img',
            state: 'running',
            composeProject: null,
            serviceKey: '',
            startedAt: null,
            finishedAt: null,
            exitCode: null,
            labels: {},
            ports: [],
            mounts: [],
            updatedAt: new Date(),
          },
        ],
      });
    });

    act(() => {
      sendEvent(es, {
        type: 'init',
        containers: [
          {
            host: 'server2',
            containerId: 'xyz789',
            name: 'traefik',
            image: 'traefik:latest',
            state: 'running',
            composeProject: null,
            serviceKey: '',
            startedAt: null,
            finishedAt: null,
            exitCode: null,
            labels: {},
            ports: [],
            mounts: [],
            updatedAt: new Date(),
          },
        ],
      });
    });

    expect(result.current.inventory.size).toBe(1);
    expect(result.current.inventory.has('server1/abc123')).toBe(false);
    expect(result.current.inventory.has('server2/xyz789')).toBe(true);
  });

  it('adds a new entry on upsert event', () => {
    const { result } = renderHook(() => useDockerInventory());
    const es = MockEventSource.instances[0];

    act(() => {
      es.onopen?.();
      sendEvent(es, { type: 'init', containers: [] });
    });

    act(() => {
      sendEvent(es, {
        type: 'upsert',
        container: {
          host: 'server1',
          containerId: 'abc123',
          name: 'plex',
          image: 'img',
          state: 'running',
          composeProject: 'media',
          serviceKey: 'media/plex',
          startedAt: null,
          finishedAt: null,
          exitCode: null,
          ports: [],
          updatedAt: new Date(),
        },
      });
    });

    expect(result.current.inventory.size).toBe(1);
    expect(result.current.inventory.has('server1/abc123')).toBe(true);
  });

  it('updates an existing entry on upsert event', () => {
    const { result } = renderHook(() => useDockerInventory());
    const es = MockEventSource.instances[0];

    const updatedAt = new Date('2026-04-16T11:00:00Z');

    act(() => {
      es.onopen?.();
      sendEvent(es, {
        type: 'init',
        containers: [
          {
            host: 'server1',
            containerId: 'abc123',
            name: 'plex',
            image: 'img',
            state: 'running',
            composeProject: null,
            serviceKey: '',
            startedAt: null,
            finishedAt: null,
            exitCode: null,
            labels: {},
            ports: [],
            mounts: [],
            updatedAt: new Date('2026-04-16T10:00:00Z'),
          },
        ],
      });
    });

    act(() => {
      sendEvent(es, {
        type: 'upsert',
        container: {
          host: 'server1',
          containerId: 'abc123',
          name: 'plex',
          image: 'img',
          state: 'exited',
          composeProject: null,
          serviceKey: '',
          startedAt: null,
          finishedAt: new Date('2026-04-16T11:00:00Z'),
          exitCode: 0,
          ports: [],
          updatedAt,
        },
      });
    });

    expect(result.current.inventory.size).toBe(1);
    const entry = result.current.inventory.get('server1/abc123');
    expect(entry?.state).toBe('exited');
    expect(entry?.exitCode).toBe(0);
  });

  it('removes an entry on destroy event', () => {
    const { result } = renderHook(() => useDockerInventory());
    const es = MockEventSource.instances[0];

    act(() => {
      es.onopen?.();
      sendEvent(es, {
        type: 'init',
        containers: [
          {
            host: 'server1',
            containerId: 'abc123',
            name: 'plex',
            image: 'img',
            state: 'running',
            composeProject: null,
            serviceKey: '',
            startedAt: null,
            finishedAt: null,
            exitCode: null,
            labels: {},
            ports: [],
            mounts: [],
            updatedAt: new Date(),
          },
        ],
      });
    });

    act(() => {
      sendEvent(es, {
        type: 'destroy',
        host: 'server1',
        containerId: 'abc123',
        at: new Date(),
      });
    });

    expect(result.current.inventory.size).toBe(0);
    expect(result.current.inventory.has('server1/abc123')).toBe(false);
  });

  it('does not produce a new Map reference on destroy of unknown key', () => {
    const { result } = renderHook(() => useDockerInventory());
    const es = MockEventSource.instances[0];

    act(() => {
      es.onopen?.();
      sendEvent(es, { type: 'init', containers: [] });
    });

    const first = result.current.inventory;

    act(() => {
      sendEvent(es, {
        type: 'destroy',
        host: 'server1',
        containerId: 'nonexistent',
        at: new Date(),
      });
    });

    expect(result.current.inventory).toBe(first);
  });

  it('sets error and clears isConnected on connection error', () => {
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      ((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout
    );

    try {
      const { result } = renderHook(() => useDockerInventory());

      act(() => {
        const es0 = MockEventSource.instances[0];
        es0.onopen?.();
      });

      expect(result.current.isConnected).toBe(true);

      // Exhaust MAX_RECONNECT_ATTEMPTS (5) by always firing on the latest instance
      act(() => {
        for (let i = 0; i <= 5; i++) {
          const latest = MockEventSource.instances[MockEventSource.instances.length - 1];
          latest.onerror?.();
        }
      });

      expect(result.current.isConnected).toBe(false);
      expect(result.current.error).not.toBeNull();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('closes EventSource on unmount', () => {
    const { unmount } = renderHook(() => useDockerInventory());
    const es = MockEventSource.instances[0];

    expect(es.closed).toBe(false);
    unmount();
    expect(es.closed).toBe(true);
  });

  it('uses host/containerId composite key for cross-host uniqueness', () => {
    const { result } = renderHook(() => useDockerInventory());
    const es = MockEventSource.instances[0];

    act(() => {
      es.onopen?.();
      sendEvent(es, {
        type: 'init',
        containers: [
          {
            host: 'server1',
            containerId: 'abc123',
            name: 'plex',
            image: 'img',
            state: 'running',
            composeProject: null,
            serviceKey: '',
            startedAt: null,
            finishedAt: null,
            exitCode: null,
            labels: {},
            ports: [],
            mounts: [],
            updatedAt: new Date(),
          },
          {
            host: 'server2',
            containerId: 'abc123',
            name: 'plex',
            image: 'img',
            state: 'running',
            composeProject: null,
            serviceKey: '',
            startedAt: null,
            finishedAt: null,
            exitCode: null,
            labels: {},
            ports: [],
            mounts: [],
            updatedAt: new Date(),
          },
        ],
      });
    });

    expect(result.current.inventory.size).toBe(2);
    expect(result.current.inventory.has('server1/abc123')).toBe(true);
    expect(result.current.inventory.has('server2/abc123')).toBe(true);
  });

  it('surfaces inventory_error events and clears the error on next data', () => {
    const { result } = renderHook(() => useDockerInventory());
    const es = MockEventSource.instances[0];

    act(() => { es.onopen?.(); });
    act(() => { es.fireEvent('inventory_error'); });

    expect(result.current.error?.message).toBe('Inventory stream unavailable');

    act(() => { sendEvent(es, { type: 'init', containers: [] }); });

    expect(result.current.error).toBeNull();
  });

  it('preserves the previous entry mounts on upsert', () => {
    const { result } = renderHook(() => useDockerInventory());
    const es = MockEventSource.instances[0];

    act(() => {
      es.onopen?.();
      sendEvent(es, {
        type: 'init',
        containers: [
          {
            host: 'server1',
            containerId: 'abc123',
            name: 'plex',
            image: 'img',
            state: 'running',
            composeProject: null,
            serviceKey: '',
            startedAt: null,
            finishedAt: null,
            exitCode: null,
            labels: {},
            ports: [],
            mounts: [{ type: 'volume', source: 'plex-config', destination: '/config', rw: true }],
            updatedAt: new Date(),
          },
        ],
      });
    });

    act(() => {
      sendEvent(es, {
        type: 'upsert',
        container: {
          host: 'server1',
          containerId: 'abc123',
          name: 'plex',
          image: 'img',
          state: 'exited',
          composeProject: null,
          serviceKey: '',
          startedAt: null,
          finishedAt: null,
          exitCode: 0,
          ports: [],
          updatedAt: new Date(),
        },
      });
    });

    const entry = result.current.inventory.get('server1/abc123');
    expect(entry?.mounts).toEqual([{ type: 'volume', source: 'plex-config', destination: '/config', rw: true }]);
  });

  it('takes ports from the upsert payload rather than the previous entry', () => {
    const { result } = renderHook(() => useDockerInventory());
    const es = MockEventSource.instances[0];

    act(() => {
      es.onopen?.();
      sendEvent(es, {
        type: 'init',
        containers: [
          {
            host: 'server1',
            containerId: 'abc123',
            name: 'plex',
            image: 'img',
            state: 'running',
            composeProject: null,
            serviceKey: '',
            startedAt: null,
            finishedAt: null,
            exitCode: null,
            labels: {},
            ports: [{ containerPort: 80, protocol: 'tcp', hostIp: null, hostPort: 8080 }],
            mounts: [],
            updatedAt: new Date(),
          },
        ],
      });
    });

    act(() => {
      sendEvent(es, {
        type: 'upsert',
        container: {
          host: 'server1',
          containerId: 'abc123',
          name: 'plex',
          image: 'img',
          state: 'running',
          composeProject: null,
          serviceKey: '',
          startedAt: null,
          finishedAt: null,
          exitCode: null,
          ports: [{ containerPort: 443, protocol: 'tcp', hostIp: null, hostPort: 8443 }],
          updatedAt: new Date(),
        },
      });
    });

    const entry = result.current.inventory.get('server1/abc123');
    expect(entry?.ports).toEqual([{ containerPort: 443, protocol: 'tcp', hostIp: null, hostPort: 8443 }]);
  });
});

describe('mergeUpsert', () => {
  const baseUpdate: DockerInventoryUpdateContainer = {
    host: 'server1',
    containerId: 'abc123',
    name: 'plex',
    image: 'img',
    state: 'running',
    composeProject: null,
    serviceKey: '',
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    ports: [{ containerPort: 443, protocol: 'tcp', hostIp: null, hostPort: 8443 }],
    updatedAt: new Date(),
  };

  const basePrev: DockerInventorySnapshotContainer = {
    host: 'server1',
    containerId: 'abc123',
    name: 'plex',
    image: 'img',
    state: 'running',
    composeProject: null,
    serviceKey: '',
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    labels: { app: 'plex' },
    ports: [{ containerPort: 80, protocol: 'tcp', hostIp: null, hostPort: 8080 }],
    mounts: [{ type: 'volume', source: 'plex-config', destination: '/config', rw: true }],
    updatedAt: new Date(),
  };

  it('preserves the previous entry labels and mounts', () => {
    const merged = mergeUpsert(basePrev, baseUpdate);
    expect(merged.labels).toEqual(basePrev.labels);
    expect(merged.mounts).toEqual(basePrev.mounts);
  });

  it('takes ports from the upsert payload rather than the previous entry', () => {
    const merged = mergeUpsert(basePrev, baseUpdate);
    expect(merged.ports).toEqual(baseUpdate.ports);
  });

  it('falls back to the previous entry ports when the payload field is absent (version skew)', () => {
    const { ports: _ports, ...updateWithoutPorts } = baseUpdate;
    void _ports;
    const merged = mergeUpsert(basePrev, updateWithoutPorts as unknown as DockerInventoryUpdateContainer);
    expect(merged.ports).toEqual(basePrev.ports);
  });

  it('defaults labels, ports, and mounts to empty for a container not yet seen', () => {
    const merged = mergeUpsert(undefined, baseUpdate);
    expect(merged.labels).toEqual({});
    expect(merged.mounts).toEqual([]);
    expect(merged.ports).toEqual(baseUpdate.ports);
  });

  it('defaults ports to empty when both the payload and the previous entry omit them', () => {
    const { ports: _ports, ...updateWithoutPorts } = baseUpdate;
    void _ports;
    const merged = mergeUpsert(undefined, updateWithoutPorts as unknown as DockerInventoryUpdateContainer);
    expect(merged.ports).toEqual([]);
  });
});

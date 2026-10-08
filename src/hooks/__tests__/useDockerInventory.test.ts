import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FakeMuxConnection } from '@/lib/test/fake-mux';

const fakeMux = new FakeMuxConnection();
mock.module('@/lib/mux/mux-connection', () => ({ muxConnection: fakeMux }));

import { useDockerInventory, mergeUpsert } from '../useDockerInventory';
import { dockerInventoryChannel } from '@/lib/sse/channels/docker-inventory';
import type {
  DockerInventoryBroadcastEvent,
  DockerInventorySnapshotContainer,
  DockerInventoryUpdateContainer,
} from '@/types/docker-inventory';

const INVENTORY_TOPIC = 'inventory';

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

beforeEach(() => {
  fakeMux.subscriptions.clear();
  fakeMux.status = { connected: false, error: null };
  queryClient = new QueryClient();
});

function mountInventory() {
  return renderHook(() => useDockerInventory(), { wrapper });
}

function containerFixture(overrides: Partial<DockerInventorySnapshotContainer> = {}): DockerInventorySnapshotContainer {
  return {
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
    ...overrides,
  };
}

function sendEvent(event: DockerInventoryBroadcastEvent) {
  fakeMux.emitWire(INVENTORY_TOPIC, 'data', event);
}

describe('useDockerInventory', () => {
  it('subscribes to the inventory mux topic on mount', () => {
    mountInventory();
    expect(fakeMux.subscribedTopics()).toEqual([INVENTORY_TOPIC]);
  });

  it('starts with empty inventory and disconnected state', () => {
    const { result } = mountInventory();
    expect(result.current.inventory.size).toBe(0);
    expect(result.current.isConnected).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('sets isConnected true on mux connect', () => {
    const { result } = mountInventory();
    act(() => { fakeMux.setStatus({ connected: true, error: null }); });
    expect(result.current.isConnected).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('populates the inventory map from init and rehydrates ISO date strings to Date objects', () => {
    const { result } = mountInventory();
    act(() => {
      fakeMux.setStatus({ connected: true, error: null });
      sendEvent({
        type: 'init',
        containers: [containerFixture({
          startedAt: new Date('2026-04-16T10:00:00Z'),
          finishedAt: new Date('2026-04-16T11:00:00Z'),
          state: 'exited',
          exitCode: 0,
        })],
      });
    });

    const entry = result.current.inventory.get('server1/abc123')!;
    expect(result.current.inventory.size).toBe(1);
    expect(entry.name).toBe('plex');
    expect(entry.startedAt).toBeInstanceOf(Date);
    expect(entry.finishedAt).toBeInstanceOf(Date);
    expect(entry.updatedAt).toBeInstanceOf(Date);
    expect(entry.startedAt!.getTime()).toBe(Date.parse('2026-04-16T10:00:00Z'));
    expect(entry.updatedAt.getTime()).toBe(Date.parse('2026-04-16T10:00:00Z'));
  });

  it('replaces the entire inventory on a second init event', () => {
    const { result } = mountInventory();
    act(() => { sendEvent({ type: 'init', containers: [containerFixture()] }); });
    act(() => {
      sendEvent({ type: 'init', containers: [containerFixture({ host: 'server2', containerId: 'xyz789', name: 'traefik' })] });
    });

    expect(result.current.inventory.size).toBe(1);
    expect(result.current.inventory.has('server1/abc123')).toBe(false);
    expect(result.current.inventory.has('server2/xyz789')).toBe(true);
  });

  it('upsert adds and updates entries with revived dates', () => {
    const { result } = mountInventory();
    act(() => { sendEvent({ type: 'init', containers: [] }); });
    act(() => {
      sendEvent({
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
          ports: [],
          updatedAt: new Date('2026-04-16T10:00:00Z'),
        },
      });
    });

    let entry = result.current.inventory.get('server1/abc123');
    expect(result.current.inventory.size).toBe(1);
    expect(entry?.updatedAt).toBeInstanceOf(Date);

    act(() => {
      sendEvent({
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
          updatedAt: new Date('2026-04-16T11:00:00Z'),
        },
      });
    });

    entry = result.current.inventory.get('server1/abc123');
    expect(entry?.state).toBe('exited');
    expect(entry?.exitCode).toBe(0);
  });

  it('removes an entry on destroy and keeps the same Map reference for an unknown key', () => {
    const { result } = mountInventory();
    act(() => { sendEvent({ type: 'init', containers: [containerFixture()] }); });
    act(() => {
      sendEvent({ type: 'destroy', host: 'server1', containerId: 'abc123', at: new Date() });
    });
    expect(result.current.inventory.size).toBe(0);

    const before = result.current.inventory;
    act(() => {
      sendEvent({ type: 'destroy', host: 'server1', containerId: 'nonexistent', at: new Date() });
    });
    expect(result.current.inventory).toBe(before);
  });

  it('uses host/containerId composite keys for cross-host uniqueness', () => {
    const { result } = mountInventory();
    act(() => {
      sendEvent({
        type: 'init',
        containers: [containerFixture(), containerFixture({ host: 'server2' })],
      });
    });

    expect(result.current.inventory.size).toBe(2);
    expect(result.current.inventory.has('server1/abc123')).toBe(true);
    expect(result.current.inventory.has('server2/abc123')).toBe(true);
  });

  it('surfaces error frames and clears the error on next data', () => {
    const { result } = mountInventory();
    act(() => { fakeMux.setStatus({ connected: true, error: null }); });
    act(() => { fakeMux.emit(INVENTORY_TOPIC, 'error', { message: 'boom' }); });

    expect(result.current.error?.message).toBe('Inventory stream unavailable');

    act(() => { sendEvent({ type: 'init', containers: [] }); });
    expect(result.current.error).toBeNull();
  });

  it('unsubscribes from the mux on unmount', () => {
    const { unmount } = mountInventory();
    expect(fakeMux.subscriptionCount(INVENTORY_TOPIC)).toBe(1);
    unmount();
    expect(fakeMux.subscriptionCount(INVENTORY_TOPIC)).toBe(0);
  });
});

describe('mergeUpsert', () => {
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

  /** Parses a raw wire payload (as the server would send it) into a DockerInventoryUpdateContainer, so an omitted `ports` key exercises the real .optional() schema instead of a manual cast. */
  function parseUpdateContainer(overrides: Record<string, unknown> = {}): DockerInventoryUpdateContainer {
    const parsed = dockerInventoryChannel.schema.parse({
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
        updatedAt: new Date().toISOString(),
        ...overrides,
      },
    });
    const revived = dockerInventoryChannel.revive!(parsed);
    if (revived.type !== 'upsert') throw new Error('expected upsert');
    return revived.container;
  }

  const newPorts = [{ containerPort: 443, protocol: 'tcp', hostIp: null, hostPort: 8443 }];

  it('preserves the previous entry labels and mounts', () => {
    const update = parseUpdateContainer({ ports: newPorts });
    const merged = mergeUpsert(basePrev, update);
    expect(merged.labels).toEqual(basePrev.labels);
    expect(merged.mounts).toEqual(basePrev.mounts);
  });

  it('takes ports from the upsert payload rather than the previous entry', () => {
    const update = parseUpdateContainer({ ports: newPorts });
    const merged = mergeUpsert(basePrev, update);
    expect(merged.ports).toEqual(newPorts);
  });

  it('falls back to the previous entry ports when the wire payload omits the field', () => {
    const update = parseUpdateContainer();
    expect('ports' in update).toBe(false);
    const merged = mergeUpsert(basePrev, update);
    expect(merged.ports).toEqual(basePrev.ports);
  });

  it('defaults labels, ports, and mounts to empty for a container not yet seen', () => {
    const update = parseUpdateContainer({ ports: newPorts });
    const merged = mergeUpsert(undefined, update);
    expect(merged.labels).toEqual({});
    expect(merged.mounts).toEqual([]);
    expect(merged.ports).toEqual(newPorts);
  });

  it('defaults ports to empty when both the payload and the previous entry omit them', () => {
    const update = parseUpdateContainer();
    const merged = mergeUpsert(undefined, update);
    expect(merged.ports).toEqual([]);
  });
});

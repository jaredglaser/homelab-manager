import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { render, screen, act } from '@testing-library/react';
import { MockEventSource } from '@/lib/test/mock-event-source';
import type { DockerInventoryBroadcastEvent, DockerContainerInventory } from '@/types/docker-inventory';

const originalEventSource = globalThis.EventSource;

beforeEach(() => {
  MockEventSource.reset();
  (globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).EventSource = originalEventSource;
});

function sendInventoryEvent(event: DockerInventoryBroadcastEvent) {
  const es = MockEventSource.instances[MockEventSource.instances.length - 1];
  es.onmessage?.({ data: JSON.stringify(event) });
}

function makeContainer(overrides: Partial<DockerContainerInventory> & { host: string; containerId: string }): DockerContainerInventory {
  return {
    name: 'container',
    image: 'img',
    state: 'running',
    composeProject: null,
    serviceKey: '',
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    labels: {},
    updatedAt: new Date(),
    ...overrides,
  };
}

// Lazily import to ensure MockEventSource is set up first
async function renderSummary() {
  const { default: DockerStatusSummary } = await import('../DockerStatusSummary');
  return render(<DockerStatusSummary />);
}

describe('DockerStatusSummary', () => {
  it('shows "0 running" when inventory is empty', async () => {
    await renderSummary();
    act(() => {
      sendInventoryEvent({ type: 'init', containers: [] });
    });
    expect(screen.getByText('0')).toBeDefined();
    expect(screen.getByText('running')).toBeDefined();
  });

  it('always shows running segment even at zero', async () => {
    await renderSummary();
    act(() => {
      sendInventoryEvent({ type: 'init', containers: [] });
    });
    // "running" label must be present
    expect(screen.getByText('running')).toBeDefined();
    // "stopped" should not appear when count is 0
    expect(screen.queryByText('stopped')).toBeNull();
  });

  it('counts running containers correctly', async () => {
    await renderSummary();
    act(() => {
      sendInventoryEvent({
        type: 'init',
        containers: [
          makeContainer({ host: 'server1', containerId: 'c1', state: 'running' }),
          makeContainer({ host: 'server1', containerId: 'c2', state: 'running' }),
          makeContainer({ host: 'server1', containerId: 'c3', state: 'running' }),
        ],
      });
    });
    const numbers = screen.getAllByText('3');
    expect(numbers.length).toBeGreaterThan(0);
    expect(screen.getByText('running')).toBeDefined();
  });

  it('groups exited and dead into stopped', async () => {
    await renderSummary();
    act(() => {
      sendInventoryEvent({
        type: 'init',
        containers: [
          makeContainer({ host: 'server1', containerId: 'c1', state: 'exited' }),
          makeContainer({ host: 'server1', containerId: 'c2', state: 'dead' }),
        ],
      });
    });
    expect(screen.getByText('stopped')).toBeDefined();
    const numbers = screen.getAllByText('2');
    expect(numbers.length).toBeGreaterThan(0);
  });

  it('shows restarting segment when restarting containers exist', async () => {
    await renderSummary();
    act(() => {
      sendInventoryEvent({
        type: 'init',
        containers: [
          makeContainer({ host: 'server1', containerId: 'c1', state: 'restarting' }),
        ],
      });
    });
    expect(screen.getByText('restarting')).toBeDefined();
  });

  it('shows paused segment when paused containers exist', async () => {
    await renderSummary();
    act(() => {
      sendInventoryEvent({
        type: 'init',
        containers: [
          makeContainer({ host: 'server1', containerId: 'c1', state: 'paused' }),
        ],
      });
    });
    expect(screen.getByText('paused')).toBeDefined();
  });

  it('counts distinct hosts correctly across multiple hosts', async () => {
    await renderSummary();
    act(() => {
      sendInventoryEvent({
        type: 'init',
        containers: [
          makeContainer({ host: 'server1', containerId: 'c1', state: 'running' }),
          makeContainer({ host: 'server1', containerId: 'c2', state: 'running' }),
          makeContainer({ host: 'server2', containerId: 'c3', state: 'running' }),
        ],
      });
    });
    expect(screen.getByText('hosts')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();
  });

  it('omits host segment when inventory is empty', async () => {
    await renderSummary();
    act(() => {
      sendInventoryEvent({ type: 'init', containers: [] });
    });
    expect(screen.queryByText('hosts')).toBeNull();
  });

  it('collapses created/removing/unknown into other', async () => {
    await renderSummary();
    act(() => {
      sendInventoryEvent({
        type: 'init',
        containers: [
          makeContainer({ host: 'server1', containerId: 'c1', state: 'created' }),
          makeContainer({ host: 'server1', containerId: 'c2', state: 'removing' }),
          makeContainer({ host: 'server1', containerId: 'c3', state: 'unknown' }),
        ],
      });
    });
    expect(screen.getByText('other')).toBeDefined();
    expect(screen.queryByText('created')).toBeNull();
    expect(screen.queryByText('removing')).toBeNull();
    expect(screen.queryByText('unknown')).toBeNull();
  });

  it('renders middle-dot separators between segments', async () => {
    await renderSummary();
    act(() => {
      sendInventoryEvent({
        type: 'init',
        containers: [
          makeContainer({ host: 'server1', containerId: 'c1', state: 'running' }),
          makeContainer({ host: 'server1', containerId: 'c2', state: 'exited' }),
        ],
      });
    });
    // Both running and stopped are shown — dots should be present
    const dots = screen.getAllByText('·');
    expect(dots.length).toBeGreaterThan(0);
  });
});

import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import type { DockerContainerInventory } from '@/types/docker-inventory';

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

// Lazily import to allow module resolution to settle
const { default: DockerStatusSummary } = await import('../DockerStatusSummary');

function renderSummary(inventory: Map<string, DockerContainerInventory>) {
  return render(<DockerStatusSummary inventory={inventory} />);
}

describe('DockerStatusSummary', () => {
  it('shows "0 running" when inventory is empty', () => {
    renderSummary(new Map());
    expect(screen.getByText('0')).toBeDefined();
    expect(screen.getByText('running')).toBeDefined();
  });

  it('always shows running segment even at zero', () => {
    renderSummary(new Map());
    // "running" label must be present
    expect(screen.getByText('running')).toBeDefined();
    // "stopped" should not appear when count is 0
    expect(screen.queryByText('stopped')).toBeNull();
  });

  it('counts running containers correctly', () => {
    const inventory = new Map([
      ['server1/c1', makeContainer({ host: 'server1', containerId: 'c1', state: 'running' })],
      ['server1/c2', makeContainer({ host: 'server1', containerId: 'c2', state: 'running' })],
      ['server1/c3', makeContainer({ host: 'server1', containerId: 'c3', state: 'running' })],
    ]);
    renderSummary(inventory);
    const numbers = screen.getAllByText('3');
    expect(numbers.length).toBeGreaterThan(0);
    expect(screen.getByText('running')).toBeDefined();
  });

  it('groups exited and dead into stopped', () => {
    const inventory = new Map([
      ['server1/c1', makeContainer({ host: 'server1', containerId: 'c1', state: 'exited' })],
      ['server1/c2', makeContainer({ host: 'server1', containerId: 'c2', state: 'dead' })],
    ]);
    renderSummary(inventory);
    expect(screen.getByText('stopped')).toBeDefined();
    const numbers = screen.getAllByText('2');
    expect(numbers.length).toBeGreaterThan(0);
  });

  it('shows restarting segment when restarting containers exist', () => {
    const inventory = new Map([
      ['server1/c1', makeContainer({ host: 'server1', containerId: 'c1', state: 'restarting' })],
    ]);
    renderSummary(inventory);
    expect(screen.getByText('restarting')).toBeDefined();
  });

  it('shows paused segment when paused containers exist', () => {
    const inventory = new Map([
      ['server1/c1', makeContainer({ host: 'server1', containerId: 'c1', state: 'paused' })],
    ]);
    renderSummary(inventory);
    expect(screen.getByText('paused')).toBeDefined();
  });

  it('counts distinct hosts correctly across multiple hosts', () => {
    const inventory = new Map([
      ['server1/c1', makeContainer({ host: 'server1', containerId: 'c1', state: 'running' })],
      ['server1/c2', makeContainer({ host: 'server1', containerId: 'c2', state: 'running' })],
      ['server2/c3', makeContainer({ host: 'server2', containerId: 'c3', state: 'running' })],
    ]);
    renderSummary(inventory);
    expect(screen.getByText('hosts')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();
  });

  it('omits host segment when inventory is empty', () => {
    renderSummary(new Map());
    expect(screen.queryByText('hosts')).toBeNull();
  });

  it('collapses created/removing/unknown into other', () => {
    const inventory = new Map([
      ['server1/c1', makeContainer({ host: 'server1', containerId: 'c1', state: 'created' })],
      ['server1/c2', makeContainer({ host: 'server1', containerId: 'c2', state: 'removing' })],
      ['server1/c3', makeContainer({ host: 'server1', containerId: 'c3', state: 'unknown' })],
    ]);
    renderSummary(inventory);
    expect(screen.getByText('other')).toBeDefined();
    expect(screen.queryByText('created')).toBeNull();
    expect(screen.queryByText('removing')).toBeNull();
    expect(screen.queryByText('unknown')).toBeNull();
  });

  it('renders middle-dot separators between segments', () => {
    const inventory = new Map([
      ['server1/c1', makeContainer({ host: 'server1', containerId: 'c1', state: 'running' })],
      ['server1/c2', makeContainer({ host: 'server1', containerId: 'c2', state: 'exited' })],
    ]);
    renderSummary(inventory);
    // Both running and stopped are shown — dots should be present
    const dots = screen.getAllByText('·');
    expect(dots.length).toBeGreaterThan(0);
  });
});

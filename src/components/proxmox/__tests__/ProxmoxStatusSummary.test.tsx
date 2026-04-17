import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import ProxmoxStatusSummary from '../ProxmoxStatusSummary';
import type { ProxmoxClusterOverview, ProxmoxNode, ProxmoxVM, ProxmoxContainer } from '@/types/proxmox';

function makeNode(node: string): ProxmoxNode {
  return {
    node,
    status: 'online',
    cpu: 0,
    maxcpu: 4,
    mem: 0,
    maxmem: 8000,
    disk: 0,
    maxdisk: 0,
    uptime: 0,
    type: 'node',
    id: `node/${node}`,
  };
}

function makeVM(vmid: number, node: string): ProxmoxVM & { node: string } {
  return {
    vmid,
    name: `vm${vmid}`,
    status: 'running',
    cpu: 0,
    cpus: 2,
    mem: 0,
    maxmem: 0,
    disk: 0,
    maxdisk: 0,
    uptime: 0,
    netin: 0,
    netout: 0,
    diskread: 0,
    diskwrite: 0,
    node,
  };
}

function makeContainer(vmid: number, node: string): ProxmoxContainer & { node: string } {
  return {
    vmid,
    name: `ct${vmid}`,
    status: 'running',
    type: 'lxc',
    cpu: 0,
    cpus: 1,
    mem: 0,
    maxmem: 0,
    disk: 0,
    maxdisk: 0,
    uptime: 0,
    netin: 0,
    netout: 0,
    diskread: 0,
    diskwrite: 0,
    swap: 0,
    maxswap: 0,
    node,
  };
}

function makeOverview(overrides: Partial<ProxmoxClusterOverview> = {}): ProxmoxClusterOverview {
  return {
    clusterName: 'test-cluster',
    quorate: true,
    version: 1,
    nodes: [],
    vms: [],
    containers: [],
    storages: [],
    totals: {
      totalCpu: 0,
      usedCpu: 0,
      totalMemory: 0,
      usedMemory: 0,
      totalDisk: 0,
      usedDisk: 0,
      runningVMs: 0,
      stoppedVMs: 0,
      runningContainers: 0,
      stoppedContainers: 0,
    },
    ...overrides,
  };
}

describe('ProxmoxStatusSummary', () => {
  it('renders null when overview is null', () => {
    const { container } = render(<ProxmoxStatusSummary overview={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders null when all counts are zero', () => {
    const { container } = render(<ProxmoxStatusSummary overview={makeOverview()} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows node count', () => {
    const overview = makeOverview({
      nodes: [makeNode('pve1'), makeNode('pve2'), makeNode('pve3')],
    });
    render(<ProxmoxStatusSummary overview={overview} />);
    expect(screen.getByText('nodes')).toBeDefined();
    expect(screen.getByText('3')).toBeDefined();
  });

  it('shows VM count', () => {
    const overview = makeOverview({
      vms: [makeVM(100, 'pve1'), makeVM(101, 'pve1')],
    });
    render(<ProxmoxStatusSummary overview={overview} />);
    expect(screen.getByText('VMs')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();
  });

  it('shows LXC count', () => {
    const overview = makeOverview({
      containers: [makeContainer(200, 'pve1')],
    });
    render(<ProxmoxStatusSummary overview={overview} />);
    expect(screen.getByText('LXCs')).toBeDefined();
    expect(screen.getByText('1')).toBeDefined();
  });

  it('shows all three segments together', () => {
    const overview = makeOverview({
      nodes: [makeNode('pve1'), makeNode('pve2'), makeNode('pve3')],
      vms: [makeVM(100, 'pve1')],
      containers: [
        makeContainer(200, 'pve1'),
        makeContainer(201, 'pve2'),
        makeContainer(202, 'pve2'),
        makeContainer(203, 'pve3'),
        makeContainer(204, 'pve3'),
        makeContainer(205, 'pve3'),
        makeContainer(206, 'pve3'),
        makeContainer(207, 'pve3'),
      ],
    });
    render(<ProxmoxStatusSummary overview={overview} />);
    expect(screen.getByText('nodes')).toBeDefined();
    expect(screen.getByText('VMs')).toBeDefined();
    expect(screen.getByText('LXCs')).toBeDefined();
    // Multiple counts are rendered — use getAllByText for unambiguous assertions
    const threes = screen.getAllByText('3');
    expect(threes.length).toBeGreaterThan(0);
    expect(screen.getByText('1')).toBeDefined();
    expect(screen.getByText('8')).toBeDefined();
  });

  it('omits VMs segment when zero VMs', () => {
    const overview = makeOverview({
      nodes: [makeNode('pve1')],
    });
    render(<ProxmoxStatusSummary overview={overview} />);
    expect(screen.queryByText('VMs')).toBeNull();
    expect(screen.queryByText('LXCs')).toBeNull();
  });

  it('renders middle-dot separators between segments', () => {
    const overview = makeOverview({
      nodes: [makeNode('pve1')],
      vms: [makeVM(100, 'pve1')],
    });
    render(<ProxmoxStatusSummary overview={overview} />);
    const dots = screen.getAllByText('·');
    expect(dots.length).toBeGreaterThan(0);
  });
});

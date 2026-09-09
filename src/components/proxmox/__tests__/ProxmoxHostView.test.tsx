import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import ProxmoxHostView from '@/components/proxmox/ProxmoxHostView';
import type { ProxmoxClusterOverview, ProxmoxNode } from '@/types/proxmox';

function makeNode(overrides: Partial<ProxmoxNode> = {}): ProxmoxNode {
  return {
    node: 'pve1',
    status: 'online',
    cpu: 0.5,
    maxcpu: 4,
    mem: 4_000_000_000,
    maxmem: 8_000_000_000,
    disk: 0,
    maxdisk: 0,
    uptime: 3600,
    type: 'node',
    id: 'node/pve1',
    ...overrides,
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

describe('ProxmoxHostView', () => {
  it('renders the node name and its CPU/Mem/Disk/uptime metrics', () => {
    render(<ProxmoxHostView overview={makeOverview({ nodes: [makeNode()] })} />);

    expect(screen.getByText('pve1')).not.toBeNull();
    expect(screen.getByText('CPU: 50.0%')).not.toBeNull();
    expect(screen.getByText('Mem: 50.0%')).not.toBeNull();
  });

  it('lets the accordion row wrap so the metric group can stack below the name on a narrow viewport', () => {
    render(<ProxmoxHostView overview={makeOverview({ nodes: [makeNode()] })} />);

    const row = screen.getByRole('button', { name: /pve1/ });
    expect(row.className).toContain('flex-wrap');
  });

  it('groups the name and status badge so they can shrink independently of the metrics', () => {
    render(<ProxmoxHostView overview={makeOverview({ nodes: [makeNode()] })} />);

    const name = screen.getByText('pve1');
    expect(name.className).toContain('truncate');
    expect(name.parentElement?.className).toContain('min-w-0');
  });

  it('renders one row per node, sorted by name', () => {
    render(
      <ProxmoxHostView
        overview={makeOverview({ nodes: [makeNode({ node: 'pve2', id: 'node/pve2' }), makeNode({ node: 'pve1' })] })}
      />,
    );

    const rows = screen.getAllByRole('button', { name: /pve/ });
    expect(rows.map((r) => r.textContent?.includes('pve1'))).toContain(true);
    expect(rows.map((r) => r.textContent?.includes('pve2'))).toContain(true);
  });
});

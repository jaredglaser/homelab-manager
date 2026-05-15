import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import type { DockerHostTableRow } from '@/types/docker';

const { default: HostNameCell } = await import('@/components/docker/HostNameCell');

function makeRow(overrides: Partial<DockerHostTableRow> = {}): DockerHostTableRow {
  return {
    id: 'host-1',
    type: 'host',
    hostName: 'server1',
    totalHosts: 1,
    children: [],
    isStale: false,
    aggregated: {
      runningCount: 3,
      stoppedCount: 2,
      restartingCount: 0,
      pausedCount: 0,
      otherCount: 0,
      cpuPercent: 20,
      memoryPercent: 40,
      memoryUsage: 0,
      memoryLimit: 0,
      networkRxBytesPerSec: 0,
      networkTxBytesPerSec: 0,
      blockIoReadBytesPerSec: 0,
      blockIoWriteBytesPerSec: 0,
      staleContainerCount: 0,
    },
    ...overrides,
  } as DockerHostTableRow;
}

describe('HostNameCell', () => {
  it('renders the host name', () => {
    render(<HostNameCell row={makeRow()} expanded={false} />);
    screen.getByText('server1');
  });

  it('does not show chevron when there is only one host', () => {
    render(<HostNameCell row={makeRow({ totalHosts: 1, children: [{ id: 'c1' } as never] })} expanded={false} />);
    expect(document.querySelector('.lucide-chevron-right')).toBeNull();
  });

  it('shows chevron when multiple hosts exist and has children', () => {
    const row = makeRow({ totalHosts: 2, children: [{ id: 'c1' } as never] });
    render(<HostNameCell row={row} expanded={false} />);
    // chevron appears for canToggle condition
    expect(document.querySelector('[class*="shrink-0"]')).toBeTruthy();
  });

  it('does not show stale indicator when not stale', () => {
    render(<HostNameCell row={makeRow({ isStale: false })} expanded={false} />);
    expect(document.querySelector('.lucide-wifi-off')).toBeNull();
  });

  it('shows stale indicator when row is stale', () => {
    render(<HostNameCell row={makeRow({ isStale: true })} expanded={false} />);
    expect(document.querySelector('.lucide-wifi-off')).toBeTruthy();
  });

  it('shows stale container count chip when count > 0 and row not stale', () => {
    const row = makeRow({
      isStale: false,
      aggregated: { runningCount: 3, stoppedCount: 2, restartingCount: 0, pausedCount: 0, otherCount: 0, cpuPercent: 20, memoryPercent: 40, memoryUsage: 0, memoryLimit: 0, networkRxBytesPerSec: 0, networkTxBytesPerSec: 0, blockIoReadBytesPerSec: 0, blockIoWriteBytesPerSec: 0, staleContainerCount: 2 },
    });
    render(<HostNameCell row={row} expanded={false} />);
    screen.getByText('2 stale');
  });

  it('does not show stale chip when row itself is stale', () => {
    const row = makeRow({
      isStale: true,
      aggregated: { runningCount: 3, stoppedCount: 2, restartingCount: 0, pausedCount: 0, otherCount: 0, cpuPercent: 20, memoryPercent: 40, memoryUsage: 0, memoryLimit: 0, networkRxBytesPerSec: 0, networkTxBytesPerSec: 0, blockIoReadBytesPerSec: 0, blockIoWriteBytesPerSec: 0, staleContainerCount: 2 },
    });
    render(<HostNameCell row={row} expanded={false} />);
    expect(screen.queryByText('2 stale')).toBeNull();
  });
});

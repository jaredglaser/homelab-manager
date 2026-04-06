import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { DataTableToolbar } from '@/components/shared-table/DataTableToolbar';
import type { MetricGroup } from '@/components/shared-table/DataTable';

const cpuIcon = <span data-testid="cpu-icon">CPU</span>;
const memIcon = <span data-testid="mem-icon">MEM</span>;

const metricGroups: MetricGroup[] = [
  { label: 'CPU', columnIds: ['cpu-usage', 'cpu-temp'], icon: cpuIcon },
  { label: 'Memory', columnIds: ['mem-usage', 'mem-free'], icon: memIcon },
  { label: 'Network', columnIds: ['net-in', 'net-out'] },
];

describe('DataTableToolbar', () => {
  it('returns null when not mobile and no children', () => {
    const { container } = render(
      <DataTableToolbar
        metricGroups={metricGroups}
        activeGroupIndex={0}
        onGroupChange={() => {}}
        isMobile={false}
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('returns null when mobile but no metricGroups and no children', () => {
    const { container } = render(
      <DataTableToolbar
        activeGroupIndex={0}
        onGroupChange={() => {}}
        isMobile={true}
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('returns null when mobile but metricGroups is empty and no children', () => {
    const { container } = render(
      <DataTableToolbar
        metricGroups={[]}
        activeGroupIndex={0}
        onGroupChange={() => {}}
        isMobile={true}
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders toggle buttons on mobile with metricGroups', () => {
    render(
      <DataTableToolbar
        metricGroups={metricGroups}
        activeGroupIndex={0}
        onGroupChange={() => {}}
        isMobile={true}
      />,
    );
    expect(screen.getByRole('button', { name: 'CPU' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Memory' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Network' })).toBeDefined();
  });

  it('renders children when provided even when not mobile', () => {
    render(
      <DataTableToolbar
        activeGroupIndex={0}
        onGroupChange={() => {}}
        isMobile={false}
      >
        <span data-testid="child-element">Filter</span>
      </DataTableToolbar>,
    );
    expect(screen.getByTestId('child-element')).toBeDefined();
  });

  it('renders both toggle buttons and children on mobile', () => {
    render(
      <DataTableToolbar
        metricGroups={metricGroups}
        activeGroupIndex={0}
        onGroupChange={() => {}}
        isMobile={true}
      >
        <span data-testid="child-element">Filter</span>
      </DataTableToolbar>,
    );
    expect(screen.getByRole('button', { name: 'CPU' })).toBeDefined();
    expect(screen.getByTestId('child-element')).toBeDefined();
  });

  it('calls onGroupChange when a toggle button is clicked', () => {
    const handleChange = mock(() => {});
    render(
      <DataTableToolbar
        metricGroups={metricGroups}
        activeGroupIndex={0}
        onGroupChange={handleChange}
        isMobile={true}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Memory' }));
    expect(handleChange).toHaveBeenCalledWith(1);
  });

  it('does not call onGroupChange when clicking the already-selected button', () => {
    const handleChange = mock(() => {});
    render(
      <DataTableToolbar
        metricGroups={metricGroups}
        activeGroupIndex={0}
        onGroupChange={handleChange}
        isMobile={true}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'CPU' }));
    expect(handleChange).not.toHaveBeenCalled();
  });

  it('renders group icons when provided', () => {
    render(
      <DataTableToolbar
        metricGroups={metricGroups}
        activeGroupIndex={0}
        onGroupChange={() => {}}
        isMobile={true}
      />,
    );
    expect(screen.getByTestId('cpu-icon')).toBeDefined();
    expect(screen.getByTestId('mem-icon')).toBeDefined();
  });

  it('shows correct number of toggle buttons matching metricGroups length', () => {
    render(
      <DataTableToolbar
        metricGroups={metricGroups}
        activeGroupIndex={0}
        onGroupChange={() => {}}
        isMobile={true}
      />,
    );
    const group = screen.getByRole('group', { name: 'metric group' });
    const buttons = group.querySelectorAll('button');
    expect(buttons).toHaveLength(metricGroups.length);
  });
});

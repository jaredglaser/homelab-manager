import { describe, it, expect, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';
import type { ColumnDef } from '@tanstack/react-table';
import type { DockerContainerTableRow, DockerTableRow } from '@/types/docker';

mock.module('@/components/shared-table/DataTable', () => ({
  DataTable: ({
    data,
    expandedState,
    onExpandedChange,
  }: {
    data: DockerContainerTableRow[];
    expandedState: Record<string, boolean>;
    onExpandedChange: (state: Record<string, boolean>) => void;
  }) => (
    <div data-testid="data-table" data-expanded={JSON.stringify(expandedState)}>
      {data.map((row) => (
        <div key={row.id} data-testid={`row-${row.id}`}>
          <button
            onClick={() => onExpandedChange({ ...expandedState, [row.id]: !expandedState[row.id] })}
          >
            toggle-{row.id}
          </button>
        </div>
      ))}
    </div>
  ),
}));

const { default: ContainerSubTable } = await import('@/components/docker/ContainerSubTable');

const makeContainer = (id: string): DockerContainerTableRow => ({
  id,
  type: 'container',
  hostName: 'server1',
  isStale: false,
  inventory: {
    host: 'server1',
    containerId: id,
    name: `container-${id}`,
    image: 'nginx',
    state: 'running',
    status: 'Up 1 hour',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never,
});

const columns: ColumnDef<DockerTableRow, unknown>[] = [];

describe('ContainerSubTable', () => {
  it('renders a DataTable with the provided containers', () => {
    render(
      <ContainerSubTable
        containers={[makeContainer('c1'), makeContainer('c2')]}
        columns={columns}
        renderDetailPanel={() => null}
        rowClassName={() => ''}
        rowAttributes={() => ({} as never)}
        isContainerExpanded={() => false}
        toggleContainerExpanded={() => {}}
      />,
    );
    screen.getByTestId('row-c1');
    screen.getByTestId('row-c2');
  });

  it('passes expanded state from isContainerExpanded to the DataTable', () => {
    render(
      <ContainerSubTable
        containers={[makeContainer('c1'), makeContainer('c2')]}
        columns={columns}
        renderDetailPanel={() => null}
        rowClassName={() => ''}
        rowAttributes={() => ({} as never)}
        isContainerExpanded={(id) => id === 'c1'}
        toggleContainerExpanded={() => {}}
      />,
    );
    const table = screen.getByTestId('data-table');
    const expanded = JSON.parse(table.getAttribute('data-expanded')!);
    expect(expanded['c1']).toBe(true);
    expect(expanded['c2']).toBe(false);
  });

  it('calls toggleContainerExpanded when expanded state changes', () => {
    const toggled: string[] = [];
    const { getByText } = render(
      <ContainerSubTable
        containers={[makeContainer('c1')]}
        columns={columns}
        renderDetailPanel={() => null}
        rowClassName={() => ''}
        rowAttributes={() => ({} as never)}
        isContainerExpanded={() => false}
        toggleContainerExpanded={(id) => toggled.push(id)}
      />,
    );
    getByText('toggle-c1').click();
    expect(toggled).toContain('c1');
  });

  it('renders empty table when no containers', () => {
    const { container } = render(
      <ContainerSubTable
        containers={[]}
        columns={columns}
        renderDetailPanel={() => null}
        rowClassName={() => ''}
        rowAttributes={() => ({} as never)}
        isContainerExpanded={() => false}
        toggleContainerExpanded={() => {}}
      />,
    );
    expect(container.querySelectorAll('[data-testid^="row-"]')).toHaveLength(0);
  });
});

import { memo, useCallback, useMemo, type ReactNode } from 'react';
import type { ColumnDef, ExpandedState } from '@tanstack/react-table';
import { DataTable } from '@/components/shared-table/DataTable';
import type { DockerContainerTableRow, DockerTableRow } from '@/types/docker';

/**
 * Nested DataTable for container rows within an expanded host.
 * Detail panel renders inline with MUI Collapse animation.
 */
const ContainerSubTable = memo(function ContainerSubTable({
  containers,
  columns,
  renderDetailPanel,
  rowClassName,
  rowAttributes,
  isContainerExpanded,
  toggleContainerExpanded,
}: Readonly<{
  containers: DockerContainerTableRow[];
  columns: ColumnDef<DockerTableRow, unknown>[];
  renderDetailPanel: (row: DockerTableRow) => ReactNode;
  rowClassName: (row: DockerTableRow) => string;
  rowAttributes: (row: DockerTableRow) => Record<`data-${string}` | `aria-${string}`, string>;
  isContainerExpanded: (id: string) => boolean;
  toggleContainerExpanded: (id: string) => void;
}>) {
  const containerExpanded = useMemo<ExpandedState>(() => {
    const state: Record<string, boolean> = {};
    for (const c of containers) {
      state[c.id] = isContainerExpanded(c.id);
    }
    return state;
  }, [containers, isContainerExpanded]);

  const handleContainerExpandedChange = useCallback(
    (newExpanded: ExpandedState) => {
      if (typeof newExpanded === 'boolean') return;
      const current = containerExpanded as Record<string, boolean>;
      for (const [id, value] of Object.entries(newExpanded)) {
        if (value !== (current[id] ?? false)) {
          toggleContainerExpanded(id);
        }
      }
      for (const id of Object.keys(current)) {
        if (current[id] && !(id in newExpanded)) {
          toggleContainerExpanded(id);
        }
      }
    },
    [containerExpanded, toggleContainerExpanded],
  );

  return (
    <DataTable
      data={containers}
      columns={columns}
      getRowId={(row) => row.id}
      renderDetailPanel={renderDetailPanel}
      expandedState={containerExpanded}
      onExpandedChange={handleContainerExpandedChange}
      rowClassName={rowClassName}
      rowAttributes={rowAttributes}
      enableSorting={false}
      showHeader={false}
    />
  );
});

export default ContainerSubTable;

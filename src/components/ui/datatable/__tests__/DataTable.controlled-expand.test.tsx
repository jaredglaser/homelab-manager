import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useState, useCallback, type ReactNode } from 'react';
import { DataTable } from '../DataTable';
import type { ExpandedState } from '@tanstack/react-table';
import type { ColumnDef } from '@tanstack/react-table';
import type { DataTableFeatures } from '@/components/ui/datatable/tableFeatures';

interface TestRow {
  id: string;
  name: string;
  value: number;
}

const columns: ColumnDef<DataTableFeatures, TestRow, unknown>[] = [
  {
    id: 'name',
    accessorKey: 'name',
    header: 'Name',
    size: 200,
  },
];

const initialData: TestRow[] = [
  { id: 'a', name: 'Alpha', value: 1 },
  { id: 'b', name: 'Beta', value: 2 },
];

function Harness({ data }: { data: TestRow[] }) {
  const [expanded, setExpanded] = useState<ExpandedState>({ a: false, b: false });

  const handleExpandedChange = useCallback((newExpanded: ExpandedState) => {
    if (typeof newExpanded === 'boolean') return;
    setExpanded((prev) => {
      const next: Record<string, boolean> = { ...(prev as Record<string, boolean>) };
      for (const [id, value] of Object.entries(newExpanded)) {
        next[id] = Boolean(value);
      }
      for (const id of Object.keys(next)) {
        if (!(id in newExpanded)) delete next[id];
      }
      return next;
    });
  }, []);

  const renderDetailPanel = useCallback(
    (row: TestRow): ReactNode => (row.value === undefined ? null : <div data-testid={`detail-${row.id}`}>Detail {row.name}</div>),
    [],
  );

  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(row) => row.id}
      renderDetailPanel={renderDetailPanel}
      expandedState={expanded}
      onExpandedChange={handleExpandedChange}
    />
  );
}

describe('controlled expansion survives data refresh', () => {
  let origGetBCR: typeof HTMLElement.prototype.getBoundingClientRect;

  beforeEach(() => {
    origGetBCR = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, width: 800, height: 600, top: 0, right: 800, bottom: 600, left: 0, toJSON: () => '' };
    };
  });

  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = origGetBCR;
  });

  it('keeps the detail panel open when data rows are rebuilt with the same ids', async () => {
    const { rerender } = render(<Harness data={initialData} />);

    fireEvent.click(screen.getByText('Alpha').closest('[role="button"]')!);
    expect(screen.getByTestId('detail-a')).toBeTruthy();

    const refreshed = initialData.map((r) => ({ ...r, value: r.value + 1 }));
    rerender(<Harness data={refreshed} />);

    // v9 schedules an expansion auto-reset on data changes; let it run
    await waitFor(() => {}, { timeout: 500 });

    expect(screen.getByTestId('detail-a')).toBeTruthy();
  });
});

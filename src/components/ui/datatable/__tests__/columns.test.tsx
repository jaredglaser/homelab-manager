import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import type { ColumnDef } from '@tanstack/react-table';
import { createStore, Provider } from 'jotai';
import { metricColumn, nameColumn, statusColumn, progressColumn } from '../columns';

/** Test row type */
interface TestRow {
  id: string;
  name: string;
  value: number;
  unit: string;
  status: string;
  pct: number;
}

const sampleRow: TestRow = {
  id: 'r1',
  name: 'alpha',
  value: 42,
  unit: 'MiB/s',
  status: 'running',
  pct: 75,
};

/** Render a single cell in isolation using a minimal single-row table */
function CellRenderer<TRow>({
  column,
  row,
}: {
  column: ColumnDef<TRow, unknown>;
  row: TRow;
}) {
  const store = createStore();
  const table = useReactTable({
    data: [row],
    columns: [column],
    getRowId: (r) => (r as { id: string }).id,
    getCoreRowModel: getCoreRowModel(),
  });

  const tableRow = table.getRowModel().rows[0];
  const cell = tableRow.getVisibleCells()[0];
  return <Provider store={store}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</Provider>;
}

function HeaderRenderer<TRow>({ column }: { column: ColumnDef<TRow, unknown> }) {
  const store = createStore();
  const table = useReactTable({
    data: [],
    columns: [column],
    getRowId: (r) => (r as { id: string }).id,
    getCoreRowModel: getCoreRowModel(),
  });

  const headerGroup = table.getHeaderGroups()[0];
  const header = headerGroup.headers[0];
  return <Provider store={store}>{flexRender(header.column.columnDef.header, header.getContext())}</Provider>;
}

describe('metricColumn', () => {
  it('renders MetricCell content inside a cell', () => {
    const col = metricColumn<TestRow>({
      id: 'speed',
      header: 'Speed',
      getValue: (r) => ({ value: String(r.value), unit: r.unit }),
    });

    render(<CellRenderer column={col} row={sampleRow} />);
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('MiB/s')).toBeTruthy();
  });

  it('renders MetricHeaderCell in the header', () => {
    const col = metricColumn<TestRow>({
      id: 'speed',
      header: 'Speed',
      getValue: (r) => ({ value: String(r.value), unit: r.unit }),
    });

    render(<HeaderRenderer column={col} />);
    expect(screen.getByText('Speed')).toBeTruthy();
  });

  it('passes isStale from getIsStale', () => {
    const col = metricColumn<TestRow>({
      id: 'speed',
      header: 'Speed',
      getValue: (r) => ({ value: String(r.value), unit: r.unit }),
      getIsStale: () => true,
    });

    const { container } = render(<CellRenderer column={col} row={sampleRow} />);
    // Stale class is applied to value and unit spans
    expect(container.querySelector('.opacity-50')).toBeTruthy();
  });

  it('exposes sizeCompact and sizeFull in meta for viewport-aware grid sizing', () => {
    const col = metricColumn<TestRow>({
      id: 'speed',
      header: 'Speed',
      getValue: (r) => ({ value: String(r.value), unit: r.unit }),
    });

    const meta = col.meta as { sizeCompact: number; sizeFull: number };
    expect(meta.sizeCompact).toBe(115);
    expect(meta.sizeFull).toBe(180);
  });
});

describe('nameColumn', () => {
  it('default cell renders the label text', () => {
    const col = nameColumn<TestRow>({ getLabel: (r) => r.name });

    render(<CellRenderer column={col} row={sampleRow} />);
    expect(screen.getByText('alpha')).toBeTruthy();
  });

  it('applies indent padding when getIndent is provided', () => {
    const col = nameColumn<TestRow>({
      getLabel: (r) => r.name,
      getIndent: () => 2,
    });

    const { container } = render(<CellRenderer column={col} row={sampleRow} />);
    const el = container.querySelector('[style*="padding-left"]') as HTMLElement | null;
    expect(el).toBeTruthy();
    expect(el?.style.paddingLeft).toBe('24px');
  });

  it('renders status indicator when getStatusColor is provided', () => {
    const col = nameColumn<TestRow>({
      getLabel: (r) => r.name,
      getStatusColor: () => '#00ff00',
    });

    const { container } = render(<CellRenderer column={col} row={sampleRow} />);
    const dot = container.querySelector('.w-2.h-2') as HTMLElement | null;
    expect(dot).toBeTruthy();
  });

  it('renders icon when getIcon returns a URL', () => {
    const col = nameColumn<TestRow>({
      getLabel: (r) => r.name,
      getIcon: () => '/icons/test.png',
    });

    const { container } = render(<CellRenderer column={col} row={sampleRow} />);
    const img = container.querySelector('img') as HTMLImageElement | null;
    expect(img).toBeTruthy();
    expect(img?.src).toContain('/icons/test.png');
  });

  it('custom cell override is used instead of default', () => {
    const col = nameColumn<TestRow>({
      getLabel: (r) => r.name,
      cell: () => <span data-testid="custom-cell">custom</span>,
    });

    render(<CellRenderer column={col} row={sampleRow} />);
    expect(screen.getByTestId('custom-cell')).toBeTruthy();
    expect(screen.queryByText('alpha')).toBeNull();
  });

});

describe('statusColumn', () => {
  it('renders a Chip with the status label', () => {
    const col = statusColumn<TestRow>({
      id: 'status',
      getValue: (r) => r.status,
      getColor: () => 'success',
    });

    render(<CellRenderer column={col} row={sampleRow} />);
    expect(screen.getByText('running')).toBeTruthy();
  });

  it('renders a Badge element', () => {
    const col = statusColumn<TestRow>({
      id: 'status',
      getValue: (r) => r.status,
      getColor: () => 'default',
    });

    const { container } = render(<CellRenderer column={col} row={sampleRow} />);
    const badge = container.querySelector('[data-slot="badge"]');
    expect(badge).toBeTruthy();
  });

});

describe('progressColumn', () => {
  it('renders the label text', () => {
    const col = progressColumn<TestRow>({
      id: 'usage',
      getValue: (r) => r.pct,
      getLabel: (r) => `${r.pct}%`,
    });

    render(<CellRenderer column={col} row={sampleRow} />);
    expect(screen.getByText('75%')).toBeTruthy();
  });

  it('renders a Progress element', () => {
    const col = progressColumn<TestRow>({
      id: 'usage',
      getValue: (r) => r.pct,
      getLabel: (r) => `${r.pct}%`,
    });

    const { container } = render(<CellRenderer column={col} row={sampleRow} />);
    const progress = container.querySelector('[data-slot="progress"]');
    expect(progress).toBeTruthy();
  });

  it('uses warning color for value > 70', () => {
    const col = progressColumn<TestRow>({
      id: 'usage',
      getValue: () => 80,
      getLabel: () => '80%',
    });

    const { container } = render(<CellRenderer column={col} row={sampleRow} />);
    const bar = container.querySelector('[data-slot="progress-indicator"]');
    expect(bar?.className).toContain('bg-warning');
  });

  it('uses error color for value > 90', () => {
    const col = progressColumn<TestRow>({
      id: 'usage',
      getValue: () => 95,
      getLabel: () => '95%',
    });

    const { container } = render(<CellRenderer column={col} row={sampleRow} />);
    const bar = container.querySelector('[data-slot="progress-indicator"]');
    expect(bar?.className).toContain('bg-destructive');
  });

  it('uses success color for value <= 70', () => {
    const col = progressColumn<TestRow>({
      id: 'usage',
      getValue: () => 50,
      getLabel: () => '50%',
    });

    const { container } = render(<CellRenderer column={col} row={sampleRow} />);
    const bar = container.querySelector('[data-slot="progress-indicator"]');
    expect(bar?.className).toContain('bg-success');
  });

  it('renders success color at exactly 70 (not > 70)', () => {
    const col = progressColumn<TestRow>({
      id: 'usage',
      getValue: () => 70,
      getLabel: () => '70%',
    });

    const { container } = render(<CellRenderer column={col} row={sampleRow} />);
    const bar = container.querySelector('[data-slot="progress-indicator"]');
    expect(bar?.className).toContain('bg-success');
    expect(bar?.className).not.toContain('bg-warning');
  });

  it('renders warning color at 71 (first value > 70)', () => {
    const col = progressColumn<TestRow>({
      id: 'usage',
      getValue: () => 71,
      getLabel: () => '71%',
    });

    const { container } = render(<CellRenderer column={col} row={sampleRow} />);
    const bar = container.querySelector('[data-slot="progress-indicator"]');
    expect(bar?.className).toContain('bg-warning');
  });

  it('renders warning color at exactly 90 (not > 90)', () => {
    const col = progressColumn<TestRow>({
      id: 'usage',
      getValue: () => 90,
      getLabel: () => '90%',
    });

    const { container } = render(<CellRenderer column={col} row={sampleRow} />);
    const bar = container.querySelector('[data-slot="progress-indicator"]');
    expect(bar?.className).toContain('bg-warning');
    expect(bar?.className).not.toContain('bg-destructive');
  });

  it('renders error color at 91 (first value > 90)', () => {
    const col = progressColumn<TestRow>({
      id: 'usage',
      getValue: () => 91,
      getLabel: () => '91%',
    });

    const { container } = render(<CellRenderer column={col} row={sampleRow} />);
    const bar = container.querySelector('[data-slot="progress-indicator"]');
    expect(bar?.className).toContain('bg-destructive');
  });
});

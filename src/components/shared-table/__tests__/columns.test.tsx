import { describe, it, expect, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import type { ColumnDef } from '@tanstack/react-table';
import { metricColumn, nameColumn, statusColumn, progressColumn } from '../columns';

/** Minimal mock for useSettings used inside MetricHeaderCell */
mock.module('@/hooks/useSettings', () => ({
  useSettings: () => ({
    general: { useAbbreviatedUnits: false, showSparklines: false },
  }),
}));

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
  const table = useReactTable({
    data: [row],
    columns: [column],
    getRowId: (r) => (r as { id: string }).id,
    getCoreRowModel: getCoreRowModel(),
  });

  const tableRow = table.getRowModel().rows[0];
  const cell = tableRow.getVisibleCells()[0];
  return <>{flexRender(cell.column.columnDef.cell, cell.getContext())}</>;
}

function HeaderRenderer<TRow>({ column }: { column: ColumnDef<TRow, unknown> }) {
  const table = useReactTable({
    data: [],
    columns: [column],
    getRowId: (r) => (r as { id: string }).id,
    getCoreRowModel: getCoreRowModel(),
  });

  const headerGroup = table.getHeaderGroups()[0];
  const header = headerGroup.headers[0];
  return <>{flexRender(header.column.columnDef.header, header.getContext())}</>;
}

describe('metricColumn', () => {
  it('returns a ColumnDef with the correct id', () => {
    const col = metricColumn<TestRow>({
      id: 'speed',
      header: 'Speed',
      getValue: (r) => ({ value: String(r.value), unit: r.unit }),
    });
    expect(col.id).toBe('speed');
  });

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

  it('sets meta.minBreakpoint when provided', () => {
    const col = metricColumn<TestRow>({
      id: 'speed',
      header: 'Speed',
      getValue: (r) => ({ value: String(r.value), unit: r.unit }),
      minBreakpoint: 'lg',
    });

    const meta = col.meta as { minBreakpoint?: string } | undefined;
    expect(meta?.minBreakpoint).toBe('lg');
  });

  it('sets size when provided', () => {
    const col = metricColumn<TestRow>({
      id: 'speed',
      header: 'Speed',
      getValue: (r) => ({ value: String(r.value), unit: r.unit }),
      size: 120,
    });

    expect(col.size).toBe(120);
  });
});

describe('nameColumn', () => {
  it('returns a ColumnDef with id "name"', () => {
    const col = nameColumn<TestRow>({ getLabel: (r) => r.name });
    expect(col.id).toBe('name');
  });

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

  it('sets meta.flex to minmax(200px, 1fr)', () => {
    const col = nameColumn<TestRow>({ getLabel: (r) => r.name });
    const meta = col.meta as { flex?: string } | undefined;
    expect(meta?.flex).toBe('minmax(200px, 1fr)');
  });
});

describe('statusColumn', () => {
  it('returns a ColumnDef with the correct id', () => {
    const col = statusColumn<TestRow>({
      id: 'status',
      getValue: (r) => r.status,
      getColor: () => 'success',
    });
    expect(col.id).toBe('status');
  });

  it('renders a Chip with the status label', () => {
    const col = statusColumn<TestRow>({
      id: 'status',
      getValue: (r) => r.status,
      getColor: () => 'success',
    });

    render(<CellRenderer column={col} row={sampleRow} />);
    expect(screen.getByText('running')).toBeTruthy();
  });

  it('renders a Chip element (MUI chip role)', () => {
    const col = statusColumn<TestRow>({
      id: 'status',
      getValue: (r) => r.status,
      getColor: () => 'default',
    });

    const { container } = render(<CellRenderer column={col} row={sampleRow} />);
    // MUI Chip renders with role="button" or as a div with MuiChip class
    const chip = container.querySelector('.MuiChip-root');
    expect(chip).toBeTruthy();
  });

  it('sets size when provided', () => {
    const col = statusColumn<TestRow>({
      id: 'status',
      getValue: (r) => r.status,
      getColor: () => 'error',
      size: 100,
    });
    expect(col.size).toBe(100);
  });
});

describe('progressColumn', () => {
  it('returns a ColumnDef with the correct id', () => {
    const col = progressColumn<TestRow>({
      id: 'usage',
      getValue: (r) => r.pct,
      getLabel: (r) => `${r.pct}%`,
    });
    expect(col.id).toBe('usage');
  });

  it('renders the label text', () => {
    const col = progressColumn<TestRow>({
      id: 'usage',
      getValue: (r) => r.pct,
      getLabel: (r) => `${r.pct}%`,
    });

    render(<CellRenderer column={col} row={sampleRow} />);
    expect(screen.getByText('75%')).toBeTruthy();
  });

  it('renders a LinearProgress element', () => {
    const col = progressColumn<TestRow>({
      id: 'usage',
      getValue: (r) => r.pct,
      getLabel: (r) => `${r.pct}%`,
    });

    const { container } = render(<CellRenderer column={col} row={sampleRow} />);
    const progress = container.querySelector('.MuiLinearProgress-root');
    expect(progress).toBeTruthy();
  });

  it('uses warning color for value > 70', () => {
    const col = progressColumn<TestRow>({
      id: 'usage',
      getValue: () => 80,
      getLabel: () => '80%',
    });

    const { container } = render(<CellRenderer column={col} row={sampleRow} />);
    const progress = container.querySelector('.MuiLinearProgress-colorWarning');
    expect(progress).toBeTruthy();
  });

  it('uses error color for value > 90', () => {
    const col = progressColumn<TestRow>({
      id: 'usage',
      getValue: () => 95,
      getLabel: () => '95%',
    });

    const { container } = render(<CellRenderer column={col} row={sampleRow} />);
    const progress = container.querySelector('.MuiLinearProgress-colorError');
    expect(progress).toBeTruthy();
  });

  it('uses success color for value <= 70', () => {
    const col = progressColumn<TestRow>({
      id: 'usage',
      getValue: () => 50,
      getLabel: () => '50%',
    });

    const { container } = render(<CellRenderer column={col} row={sampleRow} />);
    const progress = container.querySelector('.MuiLinearProgress-colorSuccess');
    expect(progress).toBeTruthy();
  });

  it('sets size when provided', () => {
    const col = progressColumn<TestRow>({
      id: 'usage',
      getValue: (r) => r.pct,
      getLabel: (r) => `${r.pct}%`,
      size: 150,
    });
    expect(col.size).toBe(150);
  });
});

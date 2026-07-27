import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { DataTable, SPARKLINE_MIN_WIDTH, type DataTableProps } from '../DataTable';
import type { ColumnDef } from '@tanstack/react-table';
import * as useSettingsModule from '@/hooks/useSettings';

interface TestRow {
  id: string;
  name: string;
  value: number;
  children?: TestRow[];
}

const columns: ColumnDef<TestRow, unknown>[] = [
  {
    id: 'name',
    accessorKey: 'name',
    header: 'Name',
    size: 200,
    meta: { flex: 'minmax(200px, 1fr)' },
  },
  {
    id: 'value',
    accessorKey: 'value',
    header: 'Value',
    size: 100,
  },
];

const testData: TestRow[] = [
  { id: '1', name: 'Alpha', value: 30 },
  { id: '2', name: 'Beta', value: 10 },
  { id: '3', name: 'Charlie', value: 20 },
];

function defaultProps(overrides?: Partial<DataTableProps<TestRow>>) {
  return {
    data: testData,
    columns,
    getRowId: (row) => row.id,
    ...overrides,
  } as DataTableProps<TestRow>;
}

/**
 * Mock element dimensions so useVirtualizer renders rows.
 * Happy-DOM returns 0 for getBoundingClientRect and clientHeight by default,
 * which causes the virtualizer to think the scroll area has no space.
 */
let origGetBCR: typeof HTMLElement.prototype.getBoundingClientRect;
const origDescriptors = {
  clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
  scrollHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight'),
  offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight'),
};

beforeEach(() => {
  origGetBCR = HTMLElement.prototype.getBoundingClientRect;

  HTMLElement.prototype.getBoundingClientRect = function () {
    return {
      x: 0, y: 0, width: 800, height: 600,
      top: 0, right: 800, bottom: 600, left: 0,
      toJSON: () => '',
    };
  };

  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() { return 600; },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() { return 600; },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() { return 600; },
  });
});

afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = origGetBCR;

  if (origDescriptors.clientHeight) {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', origDescriptors.clientHeight);
  }
  if (origDescriptors.scrollHeight) {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', origDescriptors.scrollHeight);
  }
  if (origDescriptors.offsetHeight) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', origDescriptors.offsetHeight);
  }
});

describe('DataTable', () => {
  it('renders header cells from column defs', () => {
    render(<DataTable {...defaultProps()} />);
    expect(screen.getByText('Name')).toBeTruthy();
    expect(screen.getByText('Value')).toBeTruthy();
  });

  it('renders data rows', () => {
    render(<DataTable {...defaultProps()} />);
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('Beta')).toBeTruthy();
    expect(screen.getByText('Charlie')).toBeTruthy();
  });

  it('renders empty state when no data', () => {
    render(<DataTable {...defaultProps({ data: [] })} />);
    expect(screen.getByText('No data')).toBeTruthy();
    expect(screen.queryByText('Name')).toBeNull();
  });

  it('sorts rows when header is clicked', () => {
    render(<DataTable {...defaultProps()} />);

    const nameHeader = screen.getByText('Name');
    fireEvent.click(nameHeader);

    // After first click: ascending sort
    const cells = screen.getAllByText(/Alpha|Beta|Charlie/);
    const textOrder = cells.map((el) => el.textContent);
    expect(textOrder).toEqual(['Alpha', 'Beta', 'Charlie']);

    // Click again: descending sort
    fireEvent.click(nameHeader);
    const cellsDesc = screen.getAllByText(/Alpha|Beta|Charlie/);
    const descOrder = cellsDesc.map((el) => el.textContent);
    expect(descOrder).toEqual(['Charlie', 'Beta', 'Alpha']);
  });

  it('sorts by value column', () => {
    render(<DataTable {...defaultProps()} />);

    const valueHeader = screen.getByText('Value');
    fireEvent.click(valueHeader);

    // First click sorts ascending: 10, 20, 30
    const cells = screen.getAllByText(/^(10|20|30)$/);
    const order = cells.map((el) => el.textContent);
    // TanStack Table default first-click direction may vary; verify it is sorted
    const isAsc = order[0] === '10' && order[2] === '30';
    const isDesc = order[0] === '30' && order[2] === '10';
    expect(isAsc || isDesc).toBe(true);

    // Click again to reverse
    fireEvent.click(valueHeader);
    const cells2 = screen.getAllByText(/^(10|20|30)$/);
    const order2 = cells2.map((el) => el.textContent);
    if (isAsc) {
      expect(order2).toEqual(['30', '20', '10']);
    } else {
      expect(order2).toEqual(['10', '20', '30']);
    }
  });

  it('renders detail panel when row is expanded', () => {
    const renderDetail = (row: TestRow) => (
      <div data-testid={`detail-${row.id}`}>Detail for {row.name}</div>
    );

    const expandedState = { '1': true } as const;
    const onExpandedChange = mock(() => {});

    render(
      <DataTable
        {...defaultProps({
          renderDetailPanel: renderDetail,
          expandedState,
          onExpandedChange,
        })}
      />,
    );

    expect(screen.getByTestId('detail-1')).toBeTruthy();
    expect(screen.getByText('Detail for Alpha')).toBeTruthy();

    // Other rows should not have detail panels rendered (unmountOnExit)
    expect(screen.queryByTestId('detail-2')).toBeNull();
    expect(screen.queryByTestId('detail-3')).toBeNull();
  });

  it('renders toolbar actions', () => {
    render(
      <DataTable
        {...defaultProps({
          toolbarActions: <div data-testid="toolbar">Toolbar</div>,
        })}
      />,
    );

    expect(screen.getByTestId('toolbar')).toBeTruthy();
  });

  it('applies custom row class name', () => {
    const rowClassName = (row: TestRow) => (row.value > 20 ? 'highlight' : '');

    const { container } = render(
      <DataTable {...defaultProps({ rowClassName })} />,
    );

    const highlightedRows = container.querySelectorAll('.highlight');
    expect(highlightedRows.length).toBe(1);
  });

  it('renders sort indicators', () => {
    render(<DataTable {...defaultProps()} />);

    const nameHeader = screen.getByText('Name');
    fireEvent.click(nameHeader);

    const headerCell = nameHeader.closest('[role="button"]');
    expect(headerCell).toBeTruthy();
    const svg = headerCell!.querySelector('svg');
    expect(svg).toBeTruthy();
  });

  it('renders with sub-rows (tree data)', () => {
    const treeData: TestRow[] = [
      {
        id: 'parent',
        name: 'Parent',
        value: 100,
        children: [
          { id: 'child1', name: 'Child 1', value: 50 },
          { id: 'child2', name: 'Child 2', value: 50 },
        ],
      },
    ];

    render(
      <DataTable
        {...defaultProps({
          data: treeData,
          getSubRows: (row) => row.children,
          expandedState: true,
        })}
      />,
    );

    expect(screen.getByText('Parent')).toBeTruthy();
    expect(screen.getByText('Child 1')).toBeTruthy();
    expect(screen.getByText('Child 2')).toBeTruthy();
  });

  it('renders empty state with toolbar actions', () => {
    render(
      <DataTable
        {...defaultProps({
          data: [],
          toolbarActions: <div data-testid="toolbar">Actions</div>,
        })}
      />,
    );

    expect(screen.getByText('No data')).toBeTruthy();
    expect(screen.getByTestId('toolbar')).toBeTruthy();
  });

  it('disables sorting when enableSorting is false', () => {
    render(<DataTable {...defaultProps({ enableSorting: false })} />);

    const nameHeader = screen.getByText('Name');
    const headerCell = nameHeader.closest('[role="button"]');
    expect(headerCell).toBeNull();
  });

  it('uses virtualized rendering when row count exceeds threshold', () => {
    const manyRows: TestRow[] = Array.from({ length: 200 }, (_, i) => ({
      id: String(i),
      name: `Row ${i}`,
      value: i,
    }));

    const { container } = render(
      <DataTable {...defaultProps({ data: manyRows })} />,
    );

    // Should have absolute-positioned wrappers (virtualized)
    const absoluteRows = container.querySelectorAll('[style*="position: absolute"]');
    expect(absoluteRows.length).toBeGreaterThan(0);

    // Should NOT have content-visibility rows
    const cvRows = container.querySelectorAll('[style*="content-visibility: auto"]');
    expect(cvRows.length).toBe(0);
  });

  it('toggles expansion using internal state when no controlled expansion is provided', () => {
    const renderDetail = (row: TestRow) => (
      <div data-testid={`detail-${row.id}`}>Detail for {row.name}</div>
    );

    render(
      <DataTable
        {...defaultProps({
          renderDetailPanel: renderDetail,
        })}
      />,
    );

    // Initially no detail panels
    expect(screen.queryByTestId('detail-1')).toBeNull();

    // Click the first row to expand
    const firstRow = screen.getByText('Alpha').closest('[role="button"]')!;
    fireEvent.click(firstRow);

    expect(screen.getByTestId('detail-1')).toBeTruthy();
    expect(screen.getByText('Detail for Alpha')).toBeTruthy();
  });

  it('calls onExpandedChange when controlled expansion is provided', () => {
    const renderDetail = (row: TestRow) => (
      <div data-testid={`detail-${row.id}`}>Detail for {row.name}</div>
    );
    const onExpandedChange = mock(() => {});

    render(
      <DataTable
        {...defaultProps({
          renderDetailPanel: renderDetail,
          expandedState: {},
          onExpandedChange,
        })}
      />,
    );

    // Click the first row to trigger expansion
    const firstRow = screen.getByText('Alpha').closest('[role="button"]')!;
    fireEvent.click(firstRow);

    expect(onExpandedChange).toHaveBeenCalled();
  });

  it('hides non-active metric group columns on mobile', () => {
    // Mock ResizeObserver to report a narrow width
    const originalResizeObserver = globalThis.ResizeObserver;
    let resizeCallback: ResizeObserverCallback | null = null;

    globalThis.ResizeObserver = class MockResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        resizeCallback = cb;
      }
      observe() {
        // Immediately fire with a narrow width (below 1024 MOBILE_BREAKPOINT)
        if (resizeCallback) {
          resizeCallback(
            [{ contentRect: { width: 800 } } as unknown as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        }
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    const columnsWithGroups: typeof columns = [
      { id: 'name', accessorKey: 'name', header: 'Name', size: 200, meta: { flex: 'minmax(200px, 1fr)' } },
      { id: 'cpu', accessorFn: () => 1, header: 'CPU', size: 100 },
      { id: 'memory', accessorFn: () => 2, header: 'Memory', size: 100 },
    ];

    const metricGroups = [
      { label: 'CPU', columnIds: ['cpu'] as [string, ...string[]] },
      { label: 'Memory', columnIds: ['memory'] as [string, ...string[]] },
    ];

    try {
      render(
        <DataTable
          data={testData}
          columns={columnsWithGroups}
          getRowId={(row) => row.id}
          metricGroups={metricGroups}
        />,
      );

      // Active group is index 0 (CPU) by default, so Memory column should be hidden
      // The toolbar renders toggle buttons for each group, so "CPU" appears twice (toolbar + header).
      // Use getAllByText to confirm the CPU header column is present.
      expect(screen.getAllByText('CPU').length).toBeGreaterThanOrEqual(2); // toolbar button + header cell
      expect(screen.getByText('Name')).toBeTruthy();
      // Memory column header should not be rendered (column hidden).
      // The toolbar Memory toggle button still exists, so check that only 1 "Memory" element is found.
      const memoryElements = screen.getAllByText('Memory');
      expect(memoryElements.length).toBe(1); // toolbar button only, no header cell
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it('renders detail panel in virtualized mode', async () => {
    const manyRows: TestRow[] = Array.from({ length: 200 }, (_, i) => ({
      id: String(i),
      name: `Row ${i}`,
      value: i,
    }));

    const renderDetail = (row: TestRow) => (
      <div data-testid={`detail-${row.id}`}>Detail for {row.name}</div>
    );

    await act(async () => {
      render(
        <DataTable
          {...defaultProps({
            data: manyRows,
            renderDetailPanel: renderDetail,
            expandedState: { '0': true },
            onExpandedChange: () => {},
          })}
        />,
      );
    });

    // First row should have its detail panel rendered since it's expanded and visible
    expect(screen.getByTestId('detail-0')).toBeTruthy();
    expect(screen.getByText('Detail for Row 0')).toBeTruthy();
  });

  it('uses meta.flex value in grid template for flex columns', () => {
    const flexColumns: ColumnDef<TestRow, unknown>[] = [
      {
        id: 'name',
        header: 'Name',
        cell: ({ row }) => row.original.name,
        meta: { flex: 'minmax(200px, 1fr)' },
      },
      {
        id: 'value',
        header: 'Value',
        cell: ({ row }) => String(row.original.value),
        // No meta.flex or meta.sizeCompact/sizeFull: falls through to col.getSize()px
        size: 100,
      },
    ];

    render(
      <DataTable
        data={testData}
        columns={flexColumns}
        getRowId={(row) => row.id}
      />,
    );

    // Find the header grid element
    const headers = document.querySelectorAll('[style*="grid-template-columns"]');
    expect(headers.length).toBeGreaterThan(0);
    const style = (headers[0] as HTMLElement).style.gridTemplateColumns;
    expect(style).toContain('minmax(200px, 1fr)');
    // No meta on value column: falls through to col.getSize()px = 100px
    expect(style).toContain('100px');
  });

  describe('buildGridTemplate sparkline-aware column sizing', () => {
    // Compact and full sizes mirror what metric columns use in production.
    // Keep in sync with METRIC_COL_SIZE_COMPACT / METRIC_COL_SIZE_FULL in columns.tsx
    // if those constants are ever extracted.
    const SIZE_COMPACT = 115;
    const SIZE_FULL = 180;

    let sparklines = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let settingsSpy: any;

    beforeEach(() => {
      settingsSpy = spyOn(useSettingsModule, 'useGeneralSettings').mockImplementation(() => ({
        general: { showSparklines: sparklines, useAbbreviatedUnits: false } as never,
        retention: {} as never,
        developer: {} as never,
        setUse12HourTime: () => {},
        setUpdateInterval: () => {},
        setShowSparklines: () => {},
        setUseAbbreviatedUnits: () => {},
        setLightPalette: () => {},
        setRetention: () => {},
        setDockerDebugLogging: () => {},
        setDbFlushDebugLogging: () => {},
        setSseDebugLogging: () => {},
      }));
    });

    afterEach(() => {
      settingsSpy.mockRestore();
    });

    const metricColumns: ColumnDef<TestRow, unknown>[] = [
      {
        id: 'name',
        accessorKey: 'name',
        header: 'Name',
        meta: { flex: 'minmax(200px, 1fr)' },
      },
      {
        id: 'metric',
        header: 'Metric',
        cell: ({ row }) => String(row.original.value),
        meta: { sizeCompact: SIZE_COMPACT, sizeFull: SIZE_FULL },
      },
    ];

    function getGridTemplate(container: HTMLElement): string {
      const grids = container.querySelectorAll('[style*="grid-template-columns"]');
      expect(grids.length).toBeGreaterThan(0);
      return (grids[0] as HTMLElement).style.gridTemplateColumns;
    }

    it('uses sizeCompact when containerWidth < SPARKLINE_MIN_WIDTH (even with showSparklines=true)', () => {
      sparklines = true;
      const originalResizeObserver = globalThis.ResizeObserver;
      let resizeCallback: ResizeObserverCallback | null = null;

      globalThis.ResizeObserver = class MockResizeObserver {
        constructor(cb: ResizeObserverCallback) {
          resizeCallback = cb;
        }
        observe() {
          if (resizeCallback) {
            resizeCallback(
              [{ contentRect: { width: SPARKLINE_MIN_WIDTH - 1 } } as unknown as ResizeObserverEntry],
              this as unknown as ResizeObserver,
            );
          }
        }
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;

      try {
        const { container } = render(
          <DataTable
            data={testData}
            columns={metricColumns}
            getRowId={(row) => row.id}
          />,
        );

        const style = getGridTemplate(container);
        expect(style).toContain(`${SIZE_COMPACT}px`);
        expect(style).not.toContain(`${SIZE_FULL}px`);
      } finally {
        globalThis.ResizeObserver = originalResizeObserver;
      }
    });

    it('uses sizeFull when containerWidth >= SPARKLINE_MIN_WIDTH and showSparklines=true', () => {
      sparklines = true;
      const originalResizeObserver = globalThis.ResizeObserver;
      let resizeCallback: ResizeObserverCallback | null = null;

      globalThis.ResizeObserver = class MockResizeObserver {
        constructor(cb: ResizeObserverCallback) {
          resizeCallback = cb;
        }
        observe() {
          if (resizeCallback) {
            resizeCallback(
              [{ contentRect: { width: SPARKLINE_MIN_WIDTH } } as unknown as ResizeObserverEntry],
              this as unknown as ResizeObserver,
            );
          }
        }
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;

      try {
        const { container } = render(
          <DataTable
            data={testData}
            columns={metricColumns}
            getRowId={(row) => row.id}
          />,
        );

        const style = getGridTemplate(container);
        expect(style).toContain(`${SIZE_FULL}px`);
        expect(style).not.toContain(`${SIZE_COMPACT}px`);
      } finally {
        globalThis.ResizeObserver = originalResizeObserver;
      }
    });

    it('forces sizeCompact when showSparklines=false even at wide containerWidth', () => {
      sparklines = false;
      const originalResizeObserver = globalThis.ResizeObserver;
      let resizeCallback: ResizeObserverCallback | null = null;

      globalThis.ResizeObserver = class MockResizeObserver {
        constructor(cb: ResizeObserverCallback) {
          resizeCallback = cb;
        }
        observe() {
          if (resizeCallback) {
            resizeCallback(
              [{ contentRect: { width: SPARKLINE_MIN_WIDTH + 500 } } as unknown as ResizeObserverEntry],
              this as unknown as ResizeObserver,
            );
          }
        }
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;

      try {
        const { container } = render(
          <DataTable
            data={testData}
            columns={metricColumns}
            getRowId={(row) => row.id}
          />,
        );

        const style = getGridTemplate(container);
        expect(style).toContain(`${SIZE_COMPACT}px`);
        expect(style).not.toContain(`${SIZE_FULL}px`);
      } finally {
        globalThis.ResizeObserver = originalResizeObserver;
      }
    });
  });

  describe('mobile grid template', () => {
    function withWidth<T>(width: number, run: () => T): T {
      const originalResizeObserver = globalThis.ResizeObserver;
      let resizeCallback: ResizeObserverCallback | null = null;
      globalThis.ResizeObserver = class MockResizeObserver {
        constructor(cb: ResizeObserverCallback) {
          resizeCallback = cb;
        }
        observe() {
          resizeCallback?.(
            [{ contentRect: { width } } as unknown as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        }
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
      try {
        return run();
      } finally {
        globalThis.ResizeObserver = originalResizeObserver;
      }
    }

    const sizedColumns: ColumnDef<TestRow, unknown>[] = [
      { id: 'name', accessorKey: 'name', header: 'Name', meta: { flex: 'minmax(200px, 1fr)' } },
      { id: 'metric', header: 'Metric', cell: () => 'm', meta: { sizeCompact: 115, sizeFull: 180 } },
      { id: 'status', header: 'Status', cell: () => 's', size: 150 },
    ];

    function gridTemplateOf(container: HTMLElement): string {
      const grids = container.querySelectorAll('[style*="grid-template-columns"]');
      expect(grids.length).toBeGreaterThan(0);
      return (grids[0] as HTMLElement).style.gridTemplateColumns;
    }

    it('replaces every fixed px track with a proportional one below the breakpoint', () => {
      const template = withWidth(375, () => {
        const { container } = render(
          <DataTable data={testData} columns={sizedColumns} getRowId={(row) => row.id} />,
        );
        return gridTemplateOf(container);
      });

      expect(template).not.toContain('px');
      expect(template).toBe('minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr)');
    });

    it('keeps the fixed px tracks above the breakpoint', () => {
      const template = withWidth(1440, () => {
        const { container } = render(
          <DataTable data={testData} columns={sizedColumns} getRowId={(row) => row.id} />,
        );
        return gridTemplateOf(container);
      });

      expect(template).toContain('minmax(200px, 1fr)');
      expect(template).toContain('150px');
    });

    it('honours an explicit mobileFlex over the derived weight', () => {
      const columnsWithMobileFlex: ColumnDef<TestRow, unknown>[] = [
        { id: 'name', accessorKey: 'name', header: 'Name', meta: { flex: 'minmax(200px, 1fr)' } },
        { id: 'status', header: 'Status', cell: () => 's', size: 150, meta: { mobileFlex: 'minmax(0, 60px)' } },
      ];

      const template = withWidth(375, () => {
        const { container } = render(
          <DataTable data={testData} columns={columnsWithMobileFlex} getRowId={(row) => row.id} />,
        );
        return gridTemplateOf(container);
      });

      expect(template).toBe('minmax(0, 2fr) minmax(0, 60px)');
    });

    it('clips cells so a long name truncates instead of widening its track', () => {
      const { container } = withWidth(375, () =>
        render(
          <DataTable
            data={[{ id: '1', name: 'a-very-long-container-name-that-would-widen-the-grid', value: 1 }]}
            columns={sizedColumns}
            getRowId={(row) => row.id}
          />,
        ),
      );

      const nameCell = screen.getByText('a-very-long-container-name-that-would-widen-the-grid');
      expect(nameCell.className).toContain('min-w-0');
      expect(nameCell.className).toContain('overflow-hidden');
      expect(container.querySelectorAll('.min-w-0.overflow-hidden').length).toBe(6);
    });

    it('tightens cell padding below the breakpoint', () => {
      const { container } = withWidth(375, () =>
        render(<DataTable data={testData} columns={sizedColumns} getRowId={(row) => row.id} />),
      );

      expect(container.querySelectorAll('.px-2').length).toBeGreaterThan(0);
      expect(container.querySelectorAll('.px-3').length).toBe(0);
    });
  });

  describe('nested metric group inheritance', () => {
    function mockNarrowResizeObserver() {
      const original = globalThis.ResizeObserver;
      let cb: ResizeObserverCallback | null = null;
      globalThis.ResizeObserver = class MockResizeObserver {
        constructor(callback: ResizeObserverCallback) {
          cb = callback;
        }
        observe() {
          cb?.(
            [{ contentRect: { width: 375 } } as unknown as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        }
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
      return () => {
        globalThis.ResizeObserver = original;
      };
    }

    const nestedColumns: ColumnDef<TestRow, unknown>[] = [
      { id: 'name', accessorKey: 'name', header: 'Name', meta: { flex: 'minmax(200px, 1fr)' } },
      { id: 'cpu', header: 'CPU', cell: () => 'c' },
      { id: 'netRx', header: 'Net RX', cell: () => 'n' },
    ];

    const groups = [
      { label: 'CPU', columnIds: ['cpu'] as [string, ...string[]] },
      { label: 'Network', columnIds: ['netRx'] as [string, ...string[]] },
    ];

    it('hides the inactive group in a subtable that declares no groups of its own', () => {
      const restore = mockNarrowResizeObserver();
      try {
        render(
          <DataTable
            data={testData.slice(0, 1)}
            columns={nestedColumns}
            getRowId={(row) => row.id}
            metricGroups={groups}
            renderDetailPanel={() => (
              <DataTable
                data={testData.slice(0, 1)}
                columns={nestedColumns}
                getRowId={(row) => `sub-${row.id}`}
                showHeader={false}
              />
            )}
            expandedState={{ '1': true }}
            onExpandedChange={() => {}}
          />,
        );

        expect(screen.getAllByText('c').length).toBe(2);
        expect(screen.queryAllByText('n').length).toBe(0);
      } finally {
        restore();
      }
    });

    it('follows the parent toolbar when the active group changes', () => {
      const restore = mockNarrowResizeObserver();
      try {
        render(
          <DataTable
            data={testData.slice(0, 1)}
            columns={nestedColumns}
            getRowId={(row) => row.id}
            metricGroups={groups}
            renderDetailPanel={() => (
              <DataTable
                data={testData.slice(0, 1)}
                columns={nestedColumns}
                getRowId={(row) => `sub-${row.id}`}
                showHeader={false}
              />
            )}
            expandedState={{ '1': true }}
            onExpandedChange={() => {}}
          />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Network' }));

        expect(screen.getAllByText('n').length).toBe(2);
        expect(screen.queryAllByText('c').length).toBe(0);
      } finally {
        restore();
      }
    });

    it('leaves a standalone table with no groups fully visible', () => {
      const restore = mockNarrowResizeObserver();
      try {
        render(
          <DataTable data={testData.slice(0, 1)} columns={nestedColumns} getRowId={(row) => row.id} />,
        );

        expect(screen.getByText('c')).not.toBeNull();
        expect(screen.getByText('n')).not.toBeNull();
      } finally {
        restore();
      }
    });
  });
});

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { DataTable, type DataTableProps } from '../DataTable';
import type { ColumnDef } from '@tanstack/react-table';

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
    meta: { minWidth: 100 },
  },
  {
    id: 'value',
    accessorKey: 'value',
    header: 'Value',
    size: 100,
    meta: { minWidth: 60 },
  },
];

const testData: TestRow[] = [
  { id: '1', name: 'Alpha', value: 30 },
  { id: '2', name: 'Beta', value: 10 },
  { id: '3', name: 'Charlie', value: 20 },
];

function defaultProps(overrides?: Partial<DataTableProps<TestRow>>): DataTableProps<TestRow> {
  return {
    data: testData,
    columns,
    getRowId: (row) => row.id,
    ...overrides,
  };
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
});

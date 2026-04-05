import { useRef, useMemo, useCallback, useEffect, type ReactNode } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getExpandedRowModel,
  flexRender,
  type ColumnDef,
  type ExpandedState,
  type SortingState,
  type ColumnSizingState,
  type VisibilityState,
  type Row,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';

import { Collapse } from '@mui/material';
import { ArrowUp, ArrowDown } from 'lucide-react';
import { useState } from 'react';
import { DataTableToolbar } from '@/components/shared-table/DataTableToolbar';

export interface MetricGroup {
  label: string;
  columnIds: string[];
  icon?: ReactNode;
}

export interface DataTableProps<TRow> {
  data: TRow[];
  columns: ColumnDef<TRow, unknown>[];
  getRowId: (row: TRow) => string;

  /** Sub-row accessor for tree data expansion */
  getSubRows?: (row: TRow) => TRow[] | undefined;
  /** Render a detail panel below an expanded row */
  renderDetailPanel?: (row: TRow) => ReactNode;
  /** Controlled expansion state */
  expandedState?: ExpandedState;
  /** Callback when expansion state changes */
  onExpandedChange?: (expanded: ExpandedState) => void;

  /** Estimated height of each row in pixels (default: 41) */
  estimateRowHeight?: (index: number) => number;
  /** Number of rows to render beyond the visible area (default: 10) */
  overscan?: number;

  /** Enable row virtualization (default: true). Disable for small row counts where normal flow is preferred. */
  enableVirtualization?: boolean;
  /** Show column headers (default: true). Set false for nested tables that share parent headers. */
  showHeader?: boolean;
  /** Enable column sorting (default: true) */
  enableSorting?: boolean;
  /** Enable column filtering (default: false) */
  enableFiltering?: boolean;
  /** Enable column resizing (default: true) */
  enableColumnResizing?: boolean;
  /** Enable column visibility toggling (default: true) */
  enableColumnVisibility?: boolean;

  /** Metric groups for responsive column toggling */
  metricGroups?: MetricGroup[];

  /** Max height for the scroll container (px). Rows beyond this scroll. */
  maxHeight?: number;
  /** Custom class name for each row based on its data */
  rowClassName?: (row: TRow) => string;
  /** Toolbar actions rendered above the table */
  toolbarActions?: ReactNode;
}

const DEFAULT_ROW_HEIGHT = 41;
const DEFAULT_OVERSCAN = 20;

/**
 * Build a CSS grid-template-columns string from visible TanStack Table columns.
 * Uses column meta.flex if available, otherwise minmax(meta.minWidth, size).
 */
function buildGridTemplate<TRow>(columns: ReturnType<ReturnType<typeof useReactTable<TRow>>['getVisibleLeafColumns']>): string {
  return columns
    .map((col) => {
      const meta = col.columnDef.meta as { flex?: string; minWidth?: number } | undefined;
      if (meta?.flex) return meta.flex;
      const minW = meta?.minWidth ?? 80;
      return `minmax(${minW}px, 1fr)`;
    })
    .join(' ');
}

/** Width threshold (px) below which the table is considered mobile. */
const MOBILE_BREAKPOINT = 1024;

/**
 * Generic data table component with TanStack Table v8 column management,
 * contained virtualization via useVirtualizer, CSS Grid layout, sticky header,
 * expansion support (tree data and detail panels), and MUI Collapse animation.
 */

export function DataTable<TRow>({
  data,
  columns,
  getRowId,
  getSubRows,
  renderDetailPanel,
  expandedState: controlledExpanded,
  onExpandedChange,
  estimateRowHeight,
  overscan = DEFAULT_OVERSCAN,
  enableVirtualization = true,
  showHeader = true,
  enableSorting = true,
  enableFiltering = false,
  enableColumnResizing = true,
  enableColumnVisibility = true,
  metricGroups,
  maxHeight,
  rowClassName,
  toolbarActions,
}: Readonly<DataTableProps<TRow>>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [isMobile, setIsMobile] = useState(false);
  const [activeMetricGroupIndex, setActiveMetricGroupIndex] = useState(0);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [internalExpanded, setInternalExpanded] = useState<ExpandedState>({});

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setIsMobile(entry.contentRect.width < MOBILE_BREAKPOINT);
      }
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /**
   * Derive column visibility from the active metric group on mobile.
   * The "name" column is always visible. All metric columns outside
   * the active group are hidden when on mobile with metric groups defined.
   */
  const effectiveColumnVisibility = useMemo<VisibilityState>(() => {
    if (!isMobile || !metricGroups || metricGroups.length === 0) {
      return columnVisibility;
    }

    const activeGroup = metricGroups[activeMetricGroupIndex] ?? metricGroups[0];
    const activeIds = new Set(activeGroup.columnIds);

    const hiddenColumns: VisibilityState = {};
    for (const group of metricGroups) {
      for (const colId of group.columnIds) {
        if (!activeIds.has(colId)) {
          hiddenColumns[colId] = false;
        }
      }
    }

    return { ...columnVisibility, ...hiddenColumns };
  }, [isMobile, metricGroups, activeMetricGroupIndex, columnVisibility]);

  const expanded = controlledExpanded ?? internalExpanded;
  const setExpanded = useCallback(
    (updater: ExpandedState | ((old: ExpandedState) => ExpandedState)) => {
      const next = typeof updater === 'function' ? updater(expanded) : updater;
      if (onExpandedChange) {
        onExpandedChange(next);
      } else {
        setInternalExpanded(next);
      }
    },
    [expanded, onExpandedChange],
  );

  const table = useReactTable({
    data,
    columns,
    getRowId,
    getSubRows,
    state: {
      sorting,
      columnSizing,
      columnVisibility: effectiveColumnVisibility,
      expanded,
    },
    onSortingChange: setSorting,
    onColumnSizingChange: setColumnSizing,
    onColumnVisibilityChange: setColumnVisibility,
    onExpandedChange: setExpanded,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: enableSorting ? getSortedRowModel() : undefined,
    getFilteredRowModel: enableFiltering ? getFilteredRowModel() : undefined,
    getExpandedRowModel: getExpandedRowModel(),
    enableSorting,
    enableColumnResizing,
    enableHiding: enableColumnVisibility,
    columnResizeMode: 'onChange',
  });

  const { rows } = table.getRowModel();
  const visibleColumns = table.getVisibleLeafColumns();
  const gridTemplate = useMemo(() => buildGridTemplate(visibleColumns), [visibleColumns]);

  const defaultEstimateSize = useCallback(() => DEFAULT_ROW_HEIGHT, []);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimateRowHeight ?? defaultEstimateSize,
    overscan,
    getItemKey: (index) => rows[index].id,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  const toolbar = (
    <DataTableToolbar
      metricGroups={metricGroups}
      activeGroupIndex={activeMetricGroupIndex}
      onGroupChange={setActiveMetricGroupIndex}
      isMobile={isMobile}
    >
      {toolbarActions}
    </DataTableToolbar>
  );

  if (rows.length === 0) {
    return (
      <div ref={containerRef} className="flex flex-col flex-1 min-h-0">
        {toolbar}
        <div className="flex items-center justify-center flex-1 text-neutral-500 dark:text-neutral-400 py-12">
          No data
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex flex-col flex-1 min-h-0">
      {toolbar}

      {/* Scrollable container — header + body scroll horizontally together */}
      <div ref={scrollRef} className="overflow-y-auto overflow-x-auto flex-1 min-h-0" style={{ scrollbarGutter: 'stable', maxHeight: maxHeight ?? undefined }}>
        {/* Sticky header — inside scroll container so it tracks horizontal scroll */}
        {showHeader && (
          <div
            className="grid border-b border-neutral-200 dark:border-neutral-700 bg-[var(--mui-palette-background-default)] sticky top-0 z-10"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            {table.getHeaderGroups().map((headerGroup) =>
              headerGroup.headers.map((header) => (
                <div
                  key={header.id}
                  className={`px-3 py-2 font-semibold text-sm whitespace-nowrap select-none ${
                    header.column.getCanSort() ? 'cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-800' : ''
                  }`}
                  onClick={header.column.getToggleSortingHandler()}
                  role={header.column.getCanSort() ? 'button' : undefined}
                  tabIndex={header.column.getCanSort() ? 0 : undefined}
                  onKeyDown={
                    header.column.getCanSort()
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            header.column.toggleSorting();
                          }
                        }
                      : undefined
                  }
                >
                  {header.isPlaceholder
                  ? null
                  : flexRender(header.column.columnDef.header, header.getContext())}
                {header.column.getIsSorted() === 'asc' && <ArrowUp size={14} className="inline-block ml-1 align-text-bottom" />}
                {header.column.getIsSorted() === 'desc' && <ArrowDown size={14} className="inline-block ml-1 align-text-bottom" />}
                </div>
              )),
            )}
          </div>
        )}
        {enableVirtualization ? (
          <div
            style={{
              height: totalSize,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualItems.map((virtualRow) => {
              const row = rows[virtualRow.index];
              const isExpanded = row.getIsExpanded();
              const hasDetailPanel = renderDetailPanel != null;

              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                    contain: 'layout style',
                  }}
                >
                  <DataTableRow
                    row={row}
                    gridTemplate={gridTemplate}
                    rowClassName={rowClassName}
                    hasDetailPanel={hasDetailPanel}
                  />
                  {hasDetailPanel && (() => {
                    const panel = renderDetailPanel(row.original);
                    if (panel == null) return null;
                    return (
                      <Collapse in={isExpanded} unmountOnExit timeout={300}>
                        <div className="border-t border-neutral-200 dark:border-neutral-700">
                          {panel}
                        </div>
                      </Collapse>
                    );
                  })()}
                </div>
              );
            })}
          </div>
        ) : (
          <div>
            {rows.map((row) => {
              const isExpanded = row.getIsExpanded();
              const hasDetailPanel = renderDetailPanel != null;

              return (
                <div key={row.id}>
                  <DataTableRow
                    row={row}
                    gridTemplate={gridTemplate}
                    rowClassName={rowClassName}
                    hasDetailPanel={hasDetailPanel}
                  />
                  {hasDetailPanel && (() => {
                    const panel = renderDetailPanel(row.original);
                    if (panel == null) return null;
                    return (
                      <Collapse in={isExpanded} unmountOnExit timeout={300}>
                        <div className="border-t border-neutral-200 dark:border-neutral-700">
                          {panel}
                        </div>
                      </Collapse>
                    );
                  })()}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

interface DataTableRowProps<TRow> {
  row: Row<TRow>;
  gridTemplate: string;
  rowClassName?: (row: TRow) => string;
  hasDetailPanel?: boolean;
}

function DataTableRow<TRow>({ row, gridTemplate, rowClassName, hasDetailPanel }: Readonly<DataTableRowProps<TRow>>) {
  const customClass = rowClassName?.(row.original) ?? '';
  const canExpand = row.getCanExpand() || hasDetailPanel;

  return (
    <div
      role={canExpand ? 'button' : undefined}
      tabIndex={canExpand ? 0 : undefined}
      className={`grid border-t border-neutral-200 dark:border-neutral-700 hover:bg-blue-500/5 hover:shadow-[inset_0_0_0_1px_rgba(59,130,246,0.3)] transition-[background-color,box-shadow] duration-150 ${canExpand ? 'cursor-pointer' : ''} ${customClass}`}
      style={{ gridTemplateColumns: gridTemplate }}
      onClick={canExpand ? () => row.toggleExpanded() : undefined}
      onKeyDown={canExpand ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.toggleExpanded(); } } : undefined}
    >
      {row.getVisibleCells().map((cell) => (
        <div key={cell.id} className="px-3 py-2">
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </div>
      ))}
    </div>
  );
}

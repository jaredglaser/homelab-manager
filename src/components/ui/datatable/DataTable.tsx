import { createContext, useContext, useState, useRef, useMemo, useCallback, useEffect, type ReactNode } from 'react';
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

import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { ArrowUp, ArrowDown } from 'lucide-react';
import { DataTableToolbar } from '@/components/ui/datatable/DataTableToolbar';
import { MOBILE_BREAKPOINT } from '@/lib/constants/breakpoints';
import { useGeneralSettings } from '@/hooks/useSettings';

export interface MetricGroup {
  label: string;
  columnIds: [string, ...string[]];
  icon?: ReactNode;
}

/** Lets a nested DataTable follow its parent's selection: a subtable shares the parent's columns but owns no toolbar. */
const MetricGroupContext = createContext<{ metricGroups: MetricGroup[]; activeIndex: number } | null>(null);

type ExpansionControl =
  | { expandedState?: never; onExpandedChange?: never }
  | { expandedState: ExpandedState; onExpandedChange: (e: ExpandedState) => void };

export type DataTableProps<TRow> = {
  data: TRow[];
  columns: ColumnDef<TRow, unknown>[];
  getRowId: (row: TRow) => string;

  /** Sub-row accessor for tree data expansion */
  getSubRows?: (row: TRow) => TRow[] | undefined;
  /** Render a detail panel below an expanded row */
  renderDetailPanel?: (row: TRow) => ReactNode;

  /** Estimated height of each row in pixels (default: 41) */
  estimateRowHeight?: (index: number) => number;
  /** Number of rows to render beyond the visible area (default: 10) */
  overscan?: number;

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
  /** Custom HTML attributes for each row based on its data. Restricted to `data-*` / `aria-*`
   *  so callers cannot clobber load-bearing props like `className`, `onClick`, or `role`. */
  rowAttributes?: (row: TRow) => Record<`data-${string}` | `aria-${string}`, string>;
  /** Toolbar actions rendered above the table */
  toolbarActions?: ReactNode;
} & ExpansionControl;

const DEFAULT_ROW_HEIGHT = 41;
const DEFAULT_OVERSCAN = 20;
/** Tables below this threshold use `contentVisibility: 'auto'` instead of virtualization,
 * letting the browser natively skip layout/paint for off-screen rows. This also preserves
 * Collapse animations on nested detail panels. Virtualized rows use instant show/hide
 * to avoid layout conflicts with `contain: layout style`. */
const VIRTUALIZATION_THRESHOLD = 150;

/** Viewport width at which sparklines become visible (matches the min-[1428px] CSS breakpoint). */
export const SPARKLINE_MIN_WIDTH = 1428;

/** Grid weight the name column gets on mobile, relative to 1fr for every other column. */
const MOBILE_NAME_COLUMN_WEIGHT = 2;

/**
 * Build a CSS grid-template-columns string from visible TanStack Table columns.
 * Uses column meta.flex if available (name column: 'minmax(200px, 1fr)').
 * Metric columns store two sizes in meta: sizeFull (with sparklines) and sizeCompact
 * (without). containerWidth selects between them so the column stays tight regardless
 * of whether sparklines are enabled in settings.
 *
 * On mobile every track goes proportional instead. The fixed px sizes total more
 * than a phone viewport even after the metric-group toggle hides all but one
 * group (200 name + 2x115 metric = 430px against a 375px screen), so the table
 * would horizontally scroll no matter which group was selected.
 */
function buildGridTemplate<TRow>(
  columns: ReturnType<ReturnType<typeof useReactTable<TRow>>['getVisibleLeafColumns']>,
  containerWidth: number,
  sparklineEnabled: boolean,
  isMobile: boolean,
): string {
  const sparklinesVisible = containerWidth >= SPARKLINE_MIN_WIDTH && sparklineEnabled;
  return columns
    .map((col) => {
      const meta = col.columnDef.meta as {
        flex?: string;
        mobileFlex?: string;
        sizeCompact?: number;
        sizeFull?: number;
      } | undefined;
      if (isMobile) {
        if (meta?.mobileFlex) return meta.mobileFlex;
        return meta?.flex ? `minmax(0, ${MOBILE_NAME_COLUMN_WEIGHT}fr)` : 'minmax(0, 1fr)';
      }
      if (meta?.flex) return meta.flex;
      if (meta?.sizeCompact !== undefined && meta?.sizeFull !== undefined) {
        return `${sparklinesVisible ? meta.sizeFull : meta.sizeCompact}px`;
      }
      return `${col.getSize()}px`;
    })
    .join(' ');
}

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
  showHeader = true,
  enableSorting = true,
  enableFiltering = false,
  enableColumnResizing = true,
  enableColumnVisibility = true,
  metricGroups,
  maxHeight,
  rowClassName,
  rowAttributes,
  toolbarActions,
}: Readonly<DataTableProps<TRow>>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [isMobile, setIsMobile] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const [activeMetricGroupIndex, setActiveMetricGroupIndex] = useState(0);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [internalExpanded, setInternalExpanded] = useState<ExpandedState>({});
  const { general: { showSparklines } } = useGeneralSettings();
  const inheritedMetricGroups = useContext(MetricGroupContext);
  const ownsMetricGroups = metricGroups != null && metricGroups.length > 0;
  const effectiveMetricGroups = ownsMetricGroups ? metricGroups : inheritedMetricGroups?.metricGroups;
  const effectiveGroupIndex = ownsMetricGroups
    ? activeMetricGroupIndex
    : (inheritedMetricGroups?.activeIndex ?? 0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        const width = entry.contentRect.width;
        setIsMobile(width < MOBILE_BREAKPOINT);
        setContainerWidth(width);
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
    if (!isMobile || !effectiveMetricGroups || effectiveMetricGroups.length === 0) {
      return columnVisibility;
    }

    const activeGroup = effectiveMetricGroups[effectiveGroupIndex] ?? effectiveMetricGroups[0];
    const activeIds = new Set(activeGroup.columnIds);

    const hiddenColumns: VisibilityState = {};
    for (const group of effectiveMetricGroups) {
      for (const colId of group.columnIds) {
        if (!activeIds.has(colId)) {
          hiddenColumns[colId] = false;
        }
      }
    }

    return { ...columnVisibility, ...hiddenColumns };
  }, [isMobile, effectiveMetricGroups, effectiveGroupIndex, columnVisibility]);

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
  const isVirtualized = rows.length > VIRTUALIZATION_THRESHOLD;
  const visibleColumns = table.getVisibleLeafColumns();
  const gridTemplate = useMemo(() => buildGridTemplate(visibleColumns, containerWidth, showSparklines, isMobile), [visibleColumns, containerWidth, showSparklines, isMobile]);

  const defaultEstimateSize = useCallback(() => DEFAULT_ROW_HEIGHT, []);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimateRowHeight ?? defaultEstimateSize,
    overscan,
    getItemKey: (index) => rows[index]?.id ?? String(index),
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // Passes the ancestor's value through rather than null, so the provider can wrap
  // every path: wrapping only sometimes would remount the ref'd container.
  const metricGroupValue = useMemo(
    () => (ownsMetricGroups
      ? { metricGroups: metricGroups!, activeIndex: activeMetricGroupIndex }
      : inheritedMetricGroups),
    [ownsMetricGroups, metricGroups, activeMetricGroupIndex, inheritedMetricGroups],
  );

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
      <MetricGroupContext value={metricGroupValue}>
        <div ref={containerRef} className="flex flex-col flex-1 min-h-0">
          {toolbar}
          <div className="flex items-center justify-center flex-1 text-(--muted-foreground) py-12">
            No data
          </div>
        </div>
      </MetricGroupContext>
    );
  }

  const body = (
    <div ref={containerRef} className="flex flex-col flex-1 min-h-0">
      {toolbar}

      {/* Scrollable container: header + body scroll horizontally together */}
      <div ref={scrollRef} className="overflow-y-auto overflow-x-auto flex-1 min-h-0" style={{ scrollbarGutter: isVirtualized || maxHeight ? 'stable' : undefined, maxHeight: maxHeight ?? undefined }}>
        {/* Sticky header: inside scroll container so it tracks horizontal scroll */}
        {showHeader && (
          <div
            data-slot="datatable-header"
            className="grid border-b border-(--border) bg-(--background) sticky top-0 z-10"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            {table.getHeaderGroups().map((headerGroup) =>
              headerGroup.headers.map((header) => (
                <div
                  key={header.id}
                  className={`min-w-0 overflow-hidden py-2 font-semibold text-sm whitespace-nowrap select-none ${
                    isMobile ? 'px-2 text-xs' : 'px-3'
                  } ${header.column.getCanSort() ? 'cursor-pointer hover:bg-(--accent)' : ''}`}
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
        {isVirtualized ? (
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
                    rowAttributes={rowAttributes}
                    hasDetailPanel={hasDetailPanel}
                    isMobile={isMobile}
                  />
                  {hasDetailPanel && (() => {
                    const panel = renderDetailPanel(row.original);
                    if (panel == null || !isExpanded) return null;
                    return (
                      <div className="border-t border-border">
                        {panel}
                      </div>
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
                <div key={row.id} style={{ contentVisibility: 'auto', containIntrinsicSize: `auto ${DEFAULT_ROW_HEIGHT}px` }}>
                  <DataTableRow
                    row={row}
                    gridTemplate={gridTemplate}
                    rowClassName={rowClassName}
                    rowAttributes={rowAttributes}
                    hasDetailPanel={hasDetailPanel}
                    isMobile={isMobile}
                  />
                  {hasDetailPanel && (() => {
                    const panel = renderDetailPanel(row.original);
                    if (panel == null) return null;
                    return (
                      <Collapsible open={isExpanded}>
                        <CollapsibleContent>
                          <div className="border-t border-border">
                            {panel}
                          </div>
                        </CollapsibleContent>
                      </Collapsible>
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

  if (!metricGroupValue) return body;
  return <MetricGroupContext value={metricGroupValue}>{body}</MetricGroupContext>;
}

interface DataTableRowProps<TRow> {
  row: Row<TRow>;
  gridTemplate: string;
  rowClassName?: (row: TRow) => string;
  rowAttributes?: (row: TRow) => Record<`data-${string}` | `aria-${string}`, string>;
  hasDetailPanel?: boolean;
  isMobile?: boolean;
}

function DataTableRow<TRow>({ row, gridTemplate, rowClassName, rowAttributes, hasDetailPanel, isMobile }: Readonly<DataTableRowProps<TRow>>) {
  const customClass = rowClassName?.(row.original) ?? '';
  const extraAttributes = rowAttributes?.(row.original) ?? {};
  const canExpand = row.getCanExpand() || hasDetailPanel;

  return (
    <div
      role={canExpand ? 'button' : undefined}
      tabIndex={canExpand ? 0 : undefined}
      className={`group grid border-t border-(--border) hover:bg-(--row-hover-tint) hover:shadow-[inset_0_0_0_1px_var(--row-hover-ring)] transition-[background-color,box-shadow] duration-150 ${canExpand ? 'cursor-pointer' : ''} ${customClass}`}
      style={{ gridTemplateColumns: gridTemplate }}
      onClick={canExpand ? () => row.toggleExpanded() : undefined}
      onKeyDown={canExpand ? (e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          row.toggleExpanded();
        }
      } : undefined}
      {...extraAttributes}
    >
      {row.getVisibleCells().map((cell) => (
        // min-w-0 is load-bearing: without it a long name widens the grid track instead
        // of letting the `truncate` inside the cell take effect.
        <div key={cell.id} className={`min-w-0 overflow-hidden py-2 ${isMobile ? 'px-2' : 'px-3'}`}>
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </div>
      ))}
    </div>
  );
}

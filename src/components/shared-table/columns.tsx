import { type ColumnDef, type CellContext } from '@tanstack/react-table';
import { Chip, LinearProgress } from '@mui/material';
import type { ReactNode } from 'react';
import { MetricCell, MetricHeaderCell } from '@/components/shared-table';

/**
 * Creates a metric column that renders MetricCell with an optional sparkline.
 *
 * Callers pass showSparklines and useAbbreviatedUnits from their settings
 * context, since settings hooks cannot be called inside a column factory.
 */
export function metricColumn<TRow>(opts: {
  id: string;
  header: string;
  getValue: (row: TRow) => { value: string; unit: string };
  getSparklineData?: (row: TRow) => { timestamp: number; value: number }[];
  sparklineColor?: string;
  getIsStale?: (row: TRow) => boolean;
  hasDecimals?: boolean;
  /** Whether sparklines are visible (default: derived from sparklineColor presence) */
  showSparklines?: boolean;
  /** Whether to abbreviate unit labels (default: false) */
  useAbbreviatedUnits?: boolean;
  size?: number;
}): ColumnDef<TRow, unknown> {
  return {
    id: opts.id,
    header: () => <MetricHeaderCell>{opts.header}</MetricHeaderCell>,
    cell: ({ row }: CellContext<TRow, unknown>) => {
      const { value, unit } = opts.getValue(row.original);
      return (
        <MetricCell
          value={value}
          unit={unit}
          showSparklines={opts.showSparklines ?? !!opts.sparklineColor}
          useAbbreviatedUnits={opts.useAbbreviatedUnits ?? false}
          sparklineData={opts.getSparklineData?.(row.original)}
          sparklineColor={opts.sparklineColor}
          hasDecimals={opts.hasDecimals}
          isStale={opts.getIsStale?.(row.original)}
        />
      );
    },
    size: opts.size,
    meta: undefined,
  };
}

/**
 * Creates a name column that renders an entity label with optional
 * icon, indent padding, and status indicator.
 * Accepts a custom cell override for domain-specific name cells.
 */
export function nameColumn<TRow>(opts: {
  getLabel: (row: TRow) => string;
  getIcon?: (row: TRow) => string | undefined;
  getIndent?: (row: TRow) => number;
  getStatusColor?: (row: TRow) => string;
  size?: number;
  cell?: (props: CellContext<TRow, unknown>) => ReactNode;
}): ColumnDef<TRow, unknown> {
  return {
    id: 'name',
    header: 'Name',
    cell: opts.cell ?? (({ row }: CellContext<TRow, unknown>) => {
      const label = opts.getLabel(row.original);
      const indent = opts.getIndent?.(row.original) ?? 0;
      const statusColor = opts.getStatusColor?.(row.original);
      const icon = opts.getIcon?.(row.original);

      return (
        <div
          className="flex items-center gap-2 min-w-0 truncate"
          style={indent > 0 ? { paddingLeft: indent * 12 } : undefined}
        >
          {statusColor && (
            <span
              className="flex-shrink-0 w-2 h-2 rounded-full"
              style={{ backgroundColor: statusColor }}
            />
          )}
          {icon && (
            <img
              src={icon}
              alt=""
              className="flex-shrink-0 w-4 h-4 object-contain"
            />
          )}
          <span className="truncate">{label}</span>
        </div>
      );
    }),
    size: opts.size,
    meta: { flex: 'minmax(200px, 1fr)' },
  };
}

/**
 * Creates a status column that renders an MUI Chip with the entity's status.
 */
export function statusColumn<TRow>(opts: {
  id: string;
  getValue: (row: TRow) => string;
  getColor: (row: TRow) => 'success' | 'default' | 'warning' | 'error';
  size?: number;
}): ColumnDef<TRow, unknown> {
  return {
    id: opts.id,
    header: 'Status',
    cell: ({ row }: CellContext<TRow, unknown>) => (
      <Chip
        label={opts.getValue(row.original)}
        color={opts.getColor(row.original)}
        size="small"
        variant="outlined"
      />
    ),
    size: opts.size,
  };
}

/**
 * Creates a progress column that renders a LinearProgress bar with a label.
 * Bar color is determined by value: >90% error, >70% warning, else success.
 */
export function progressColumn<TRow>(opts: {
  id: string;
  header?: string;
  getValue: (row: TRow) => number;
  getLabel: (row: TRow) => string;
  size?: number;
}): ColumnDef<TRow, unknown> {
  return {
    id: opts.id,
    header: opts.header ?? opts.id.charAt(0).toUpperCase() + opts.id.slice(1),
    cell: ({ row }: CellContext<TRow, unknown>) => {
      const value = opts.getValue(row.original);
      const label = opts.getLabel(row.original);
      const color = value > 90 ? 'error' : value > 70 ? 'warning' : 'success';

      return (
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex-1 min-w-0">
            <LinearProgress
              variant="determinate"
              value={Math.min(100, Math.max(0, value))}
              color={color}
            />
          </div>
          <span className="flex-shrink-0 min-w-[5ch] text-right text-xs tabular-nums text-neutral-600 dark:text-neutral-300">
            {label}
          </span>
        </div>
      );
    },
    size: opts.size,
  };
}

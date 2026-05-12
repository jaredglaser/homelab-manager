import { useMemo } from 'react';
import { Collapse } from '@mui/material';
import { ChevronRight } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import type { GuestRow } from '@/types/proxmox';
import { formatAsPercentParts, formatBytesParts } from '@/formatters/metrics';
import { EMPTY_METRIC } from '@/components/shared-table';
import { DataTable, type MetricGroup } from '@/components/shared-table/DataTable';
import { nameColumn, statusColumn, metricColumn } from '@/components/shared-table/columns';
import { GuestCell } from '@/components/proxmox/GuestCell';

interface GuestSectionProps {
  label: string;
  guests: GuestRow[];
  expanded: boolean;
  onToggle: () => void;
  showSparklines: boolean;
  useAbbreviatedUnits: boolean;
}

const BORDER = 'border-t border-neutral-200 dark:border-neutral-700';

const metricGroups: MetricGroup[] = [
  { label: 'CPU / Memory', columnIds: ['cpu', 'memory'] },
  { label: 'Network', columnIds: ['netin', 'netout'] },
];

function buildColumns(showSparklines: boolean, useAbbreviatedUnits: boolean): ColumnDef<GuestRow, unknown>[] {
  return [
    nameColumn<GuestRow>({
      getLabel: (row) => row.name,
      cell: ({ row }) => (
        <GuestCell vmid={row.original.vmid} name={row.original.name} />
      ),
    }),
    statusColumn<GuestRow>({
      id: 'status',
      getValue: (row) => row.status,
      getColor: (row) => (row.status === 'running' ? 'success' : 'default'),
    }),
    metricColumn<GuestRow>({
      id: 'cpu',
      header: 'CPU',
      hasDecimals: true,
      showSparklines,
      useAbbreviatedUnits,
      getValue: (row) => {
        if (row.status !== 'running') return { value: EMPTY_METRIC, unit: '' };
        return formatAsPercentParts(row.cpu, true);
      },
    }),
    metricColumn<GuestRow>({
      id: 'memory',
      header: 'Memory',
      hasDecimals: true,
      showSparklines,
      useAbbreviatedUnits,
      getValue: (row) => {
        if (row.status === 'running') {
          const fraction = row.maxmem > 0 ? row.mem / row.maxmem : 0;
          return formatAsPercentParts(fraction, true);
        }
        return formatBytesParts(row.maxmem, false, false);
      },
    }),
    metricColumn<GuestRow>({
      id: 'netin',
      header: 'Net In',
      showSparklines,
      useAbbreviatedUnits,
      getValue: (row) => {
        if (row.status !== 'running') return { value: EMPTY_METRIC, unit: '' };
        return formatBytesParts(row.netin, false, false);
      },
    }),
    metricColumn<GuestRow>({
      id: 'netout',
      header: 'Net Out',
      showSparklines,
      useAbbreviatedUnits,
      getValue: (row) => {
        if (row.status !== 'running') return { value: EMPTY_METRIC, unit: '' };
        return formatBytesParts(row.netout, false, false);
      },
    }),
  ];
}

export function GuestSection({ label, guests, expanded, onToggle, showSparklines, useAbbreviatedUnits }: Readonly<GuestSectionProps>) {
  const sorted = useMemo(
    () => [...guests].sort((a, b) => a.vmid - b.vmid),
    [guests],
  );

  const columns = useMemo(() => buildColumns(showSparklines, useAbbreviatedUnits), [showSparklines, useAbbreviatedUnits]);

  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={`flex items-center gap-2 px-4 py-2 w-full text-left cursor-pointer ${BORDER} bg-(--mui-palette-background-level1)`}
      >
        <ChevronRight
          size={16}
          className={`transition-transform duration-200 shrink-0 ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="font-semibold text-sm">
          {label} ({guests.length})
        </span>
      </button>

      <Collapse in={expanded} unmountOnExit>
        <div className="bg-(--mui-palette-action-hover) border-b border-(--mui-palette-divider)">
          <DataTable
            data={sorted}
            columns={columns}
            getRowId={(row) => String(row.vmid)}
            metricGroups={metricGroups}
            enableSorting={false}
            enableColumnResizing={false}
            enableColumnVisibility={false}
          />
        </div>
      </Collapse>
    </>
  );
}

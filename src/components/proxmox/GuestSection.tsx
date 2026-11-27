import { useMemo } from 'react';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { ChevronRight } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import type { DataTableFeatures } from '@/components/ui/datatable/tableFeatures';
import type { GuestRow } from '@/types/proxmox';
import { formatAsPercentParts, formatBitsSIUnitsParts, formatBytesParts } from '@/formatters/metrics';
import { EMPTY_CELL } from '@/components/ui/table';
import { DataTable, type MetricGroup } from '@/components/ui/datatable/DataTable';
import { nameColumn, statusColumn, metricColumn } from '@/components/ui/datatable/columns';
import { GuestCell } from '@/components/proxmox/GuestCell';

interface GuestSectionProps {
  label: string;
  guests: GuestRow[];
  expanded: boolean;
  onToggle: () => void;
  showSparklines: boolean;
  useAbbreviatedUnits: boolean;
}

const BORDER = 'border-t border-border';

const metricGroups: MetricGroup[] = [
  { label: 'CPU / Memory', columnIds: ['cpu', 'memory'] },
  { label: 'Network', columnIds: ['netin', 'netout'] },
  { label: 'Disk I/O', columnIds: ['diskread', 'diskwrite'] },
];

const BLANK = { value: EMPTY_CELL, unit: '' };

/** A rate is blank for a stopped guest and wherever the worker had no rate (first point, restart), never 0. */
function rateCell(row: GuestRow, rate: number | null, format: (value: number) => { value: string; unit: string }) {
  if (row.status !== 'running' || rate === null) return BLANK;
  return format(rate);
}

const formatNetworkRate = (bytesPerSec: number) => formatBitsSIUnitsParts(bytesPerSec * 8, true);
const formatDiskRate = (bytesPerSec: number) => formatBytesParts(bytesPerSec, true);

function rateColumn(
  id: string,
  header: string,
  pick: (row: GuestRow) => number | null,
  format: (value: number) => { value: string; unit: string },
  showSparklines: boolean,
  useAbbreviatedUnits: boolean,
): ColumnDef<DataTableFeatures, GuestRow, unknown> {
  return metricColumn<GuestRow>({
    id,
    header,
    showSparklines,
    useAbbreviatedUnits,
    getValue: (row) => rateCell(row, pick(row), format),
  });
}

function buildColumns(showSparklines: boolean, useAbbreviatedUnits: boolean): ColumnDef<DataTableFeatures, GuestRow, unknown>[] {
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
        if (row.status !== 'running') return BLANK;
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
    rateColumn('netin', 'Net in', (row) => row.netInBytesPerSec, formatNetworkRate, showSparklines, useAbbreviatedUnits),
    rateColumn('netout', 'Net out', (row) => row.netOutBytesPerSec, formatNetworkRate, showSparklines, useAbbreviatedUnits),
    rateColumn('diskread', 'Disk read', (row) => row.diskReadBytesPerSec, formatDiskRate, showSparklines, useAbbreviatedUnits),
    rateColumn('diskwrite', 'Disk write', (row) => row.diskWriteBytesPerSec, formatDiskRate, showSparklines, useAbbreviatedUnits),
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
        className={`flex items-center gap-2 px-4 py-2 w-full text-left cursor-pointer ${BORDER} bg-level1`}
      >
        <ChevronRight
          size={16}
          className={`transition-transform duration-200 shrink-0 ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="font-semibold text-sm">
          {label} ({guests.length})
        </span>
      </button>

      <Collapsible open={expanded}>
        <CollapsibleContent>
        <div className="bg-accent border-b border-border">
          <DataTable
            data={sorted}
            columns={columns}
            getRowId={(row) => `${row.host}/${row.vmid}`}
            metricGroups={metricGroups}
            enableSorting={false}
            enableColumnResizing={false}
            enableColumnVisibility={false}
          />
        </div>
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}

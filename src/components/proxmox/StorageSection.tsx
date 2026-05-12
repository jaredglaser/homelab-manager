import { useMemo } from 'react';
import { Collapse } from '@mui/material';
import { ChevronRight } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import type { ProxmoxStorage } from '@/types/proxmox';
import { formatAsPercentParts, formatBytesParts } from '@/formatters/metrics';
import { EMPTY_METRIC } from '@/components/shared-table';
import { DataTable, type MetricGroup } from '@/components/shared-table/DataTable';
import { nameColumn, statusColumn, metricColumn, progressColumn } from '@/components/shared-table/columns';
import { StorageCell } from '@/components/proxmox/StorageCell';

interface StorageSectionProps {
  storages: ProxmoxStorage[];
  expanded: boolean;
  onToggle: () => void;
  showSparklines: boolean;
  useAbbreviatedUnits: boolean;
}

const BORDER = 'border-t border-neutral-200 dark:border-neutral-700';

const metricGroups: MetricGroup[] = [
  { label: 'Used / Available', columnIds: ['used', 'available'] },
  { label: 'Usage', columnIds: ['usage'] },
];

function buildColumns(showSparklines: boolean, useAbbreviatedUnits: boolean): ColumnDef<ProxmoxStorage, unknown>[] {
  return [
    nameColumn<ProxmoxStorage>({
      getLabel: (row) => row.storage,
      cell: ({ row }) => (
        <StorageCell name={row.original.storage} type={row.original.type} />
      ),
    }),
    statusColumn<ProxmoxStorage>({
      id: 'status',
      getValue: (row) => (row.active ? 'active' : 'inactive'),
      getColor: (row) => (row.active ? 'success' : 'default'),
    }),
    metricColumn<ProxmoxStorage>({
      id: 'used',
      header: 'Used',
      showSparklines,
      useAbbreviatedUnits,
      getValue: (row) => {
        if (row.total <= 0) return { value: EMPTY_METRIC, unit: '' };
        return formatBytesParts(row.used, false, false);
      },
    }),
    metricColumn<ProxmoxStorage>({
      id: 'available',
      header: 'Available',
      showSparklines,
      useAbbreviatedUnits,
      getValue: (row) => {
        if (row.total <= 0) return { value: EMPTY_METRIC, unit: '' };
        return formatBytesParts(row.avail, false, false);
      },
    }),
    progressColumn<ProxmoxStorage>({
      id: 'usage',
      getValue: (row) => (row.total > 0 ? Math.min(row.used_fraction * 100, 100) : 0),
      getLabel: (row) => {
        if (row.total <= 0) return EMPTY_METRIC;
        return `${formatAsPercentParts(row.used_fraction, true).value}%`;
      },
    }),
  ];
}

export function StorageSection({ storages, expanded, onToggle, showSparklines, useAbbreviatedUnits }: Readonly<StorageSectionProps>) {
  const sorted = useMemo(
    () => [...storages].sort((a, b) => a.storage.localeCompare(b.storage)),
    [storages],
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
          Storage ({storages.length})
        </span>
      </button>

      <Collapse in={expanded} unmountOnExit>
        <div className="bg-(--mui-palette-action-hover) border-b border-(--mui-palette-divider)">
          <DataTable
            data={sorted}
            columns={columns}
            getRowId={(row) => row.storage}
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

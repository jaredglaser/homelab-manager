import { Chip, LinearProgress } from '@mui/material'
import { ChevronRight } from 'lucide-react'
import type { ProxmoxStorage } from '@/types/proxmox'
import { formatAsPercentParts, formatBytesParts } from '@/formatters/metrics'
import { MetricValue, MetricHeader } from '@/components/shared-table'
import { STORAGE_GRID, BORDER, ROW_HOVER } from '@/components/proxmox/constants'

const DASH_CELL = <span className="text-right block px-3">-</span>

interface StorageSectionProps {
  storages: ProxmoxStorage[]
  expanded: boolean
  onToggle: () => void
}

/**
 * Renders a collapsible "Storage" section showing a sorted list of Proxmox storages and their metrics.
 *
 * When the header is clicked the provided `onToggle` callback is invoked. The component sorts `storages`
 * by the storage name and, when `expanded` is true, displays columns for Name, Type, Status, Used, Available,
 * and Usage. Status is shown as a small Chip labeled "active" or "inactive". Usage includes a percentage value
 * and a progress sparkline whose color is `error` when usage > 90%, `warning` when usage > 70%, and `success`
 * otherwise. Cells for Used/Available/Usage show a dash when the storage `total` is not greater than zero.
 *
 * @param storages - Array of Proxmox storage objects to display (each must include at least `storage`, `type`, `active`, `used`, `avail`, `total`, and `used_fraction`).
 * @param expanded - Whether the section is expanded to show the storage list.
 * @param onToggle - Callback invoked when the section header is clicked.
 * @returns The rendered storage section as a JSX element.
 */
export function StorageSection({ storages, expanded, onToggle }: StorageSectionProps) {
  const sorted = [...storages].sort((a, b) => a.storage.localeCompare(b.storage))

  return (
    <>
      {/* Section header row */}
      <div
        onClick={onToggle}
        className={`flex items-center gap-2 pl-10 pr-4 py-2 cursor-pointer ${BORDER} bg-[var(--mui-palette-background-level1)]`}
      >
        <ChevronRight
          size={16}
          className={`transition-transform duration-200 flex-shrink-0 ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="font-semibold text-sm">
          Storage ({storages.length})
        </span>
      </div>

      {expanded && (
        <>
          {/* Column headers */}
          <div className={`${STORAGE_GRID} ${BORDER}`}>
            <div className="px-3 py-2 font-semibold text-sm">Name</div>
            <div className="px-3 py-2 font-semibold text-sm">Type</div>
            <div className="px-3 py-2 font-semibold text-sm">Status</div>
            <div className="py-2"><MetricHeader>Used</MetricHeader></div>
            <div className="py-2"><MetricHeader>Available</MetricHeader></div>
            <div className="py-2"><MetricHeader>Usage</MetricHeader></div>
          </div>

          {/* Data rows */}
          {sorted.map((s) => {
            const usedParts = formatBytesParts(s.used, false, false)
            const availParts = formatBytesParts(s.avail, false, false)
            const usageParts = formatAsPercentParts(s.used_fraction, true)

            return (
              <div key={s.storage} className={`${STORAGE_GRID} items-center ${BORDER} ${ROW_HOVER}`}>
                <div className="px-3 py-2 font-medium">{s.storage}</div>
                <div className="px-3 py-2 text-sm">{s.type}</div>
                <div className="px-3 py-2">
                  <Chip
                    size="small"
                    variant="filled"
                    color={s.active ? 'success' : 'default'}
                    label={s.active ? 'active' : 'inactive'}
                  />
                </div>
                <div>
                  {s.total > 0 ? (
                    <MetricValue value={usedParts.value} unit={usedParts.unit} />
                  ) : DASH_CELL}
                </div>
                <div>
                  {s.total > 0 ? (
                    <MetricValue value={availParts.value} unit={availParts.unit} />
                  ) : DASH_CELL}
                </div>
                <div>
                  {s.total > 0 ? (
                    <MetricValue
                      value={usageParts.value}
                      unit={usageParts.unit}
                      hasDecimals
                      sparkline={
                        <LinearProgress
                          variant="determinate"
                          value={Math.min(s.used_fraction * 100, 100)}
                          color={
                            s.used_fraction > 0.9
                              ? 'error'
                              : s.used_fraction > 0.7
                                ? 'warning'
                                : 'success'
                          }
                          className="max-w-70"
                        />
                      }
                    />
                  ) : DASH_CELL}
                </div>
              </div>
            )
          })}
        </>
      )}
    </>
  )
}

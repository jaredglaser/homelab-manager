import { Chip, Collapse, LinearProgress } from '@mui/material'
import { ChevronRight } from 'lucide-react'
import type { ProxmoxStorage } from '@/types/proxmox'
import { formatAsPercentParts, formatBytesParts } from '@/formatters/metrics'
import { MetricValue, MetricHeader, EMPTY_METRIC } from '@/components/shared-table'
import { STORAGE_GRID, BORDER, ROW_HOVER } from '@/components/proxmox/constants'

interface StorageSectionProps {
  storages: ProxmoxStorage[]
  expanded: boolean
  onToggle: () => void
  showSparklines: boolean
  useAbbreviatedUnits: boolean
}

export function StorageSection({ storages, expanded, onToggle, showSparklines, useAbbreviatedUnits }: Readonly<StorageSectionProps>) {
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

      <Collapse in={expanded} unmountOnExit>
        <div className="bg-[var(--mui-palette-action-hover)] border-b border-[var(--mui-palette-divider)]">
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
                    <MetricValue value={usedParts.value} unit={usedParts.unit} showSparklines={showSparklines} useAbbreviatedUnits={useAbbreviatedUnits} />
                  ) : <MetricValue value={EMPTY_METRIC} unit="" showSparklines={showSparklines} useAbbreviatedUnits={useAbbreviatedUnits} />}
                </div>
                <div>
                  {s.total > 0 ? (
                    <MetricValue value={availParts.value} unit={availParts.unit} showSparklines={showSparklines} useAbbreviatedUnits={useAbbreviatedUnits} />
                  ) : <MetricValue value={EMPTY_METRIC} unit="" showSparklines={showSparklines} useAbbreviatedUnits={useAbbreviatedUnits} />}
                </div>
                <div>
                  {s.total > 0 ? (
                    <MetricValue
                      value={usageParts.value}
                      unit={usageParts.unit}
                      hasDecimals
                      showSparklines={showSparklines}
                      useAbbreviatedUnits={useAbbreviatedUnits}
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
                  ) : <MetricValue value={EMPTY_METRIC} unit="" showSparklines={showSparklines} useAbbreviatedUnits={useAbbreviatedUnits} />}
                </div>
              </div>
            )
          })}
        </div>
      </Collapse>
    </>
  )
}

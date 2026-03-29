import { Chip, Collapse } from '@mui/material'
import { ChevronRight } from 'lucide-react'
import type { GuestRow } from '@/types/proxmox'
import { formatAsPercentParts, formatBytesParts } from '@/formatters/metrics'
import { MetricValue, MetricHeader, EMPTY_METRIC } from '@/components/shared-table'
import { GUEST_GRID, BORDER, ROW_HOVER } from '@/components/proxmox/constants'

interface GuestSectionProps {
  label: string
  guests: GuestRow[]
  expanded: boolean
  onToggle: () => void
  showSparklines: boolean
  useAbbreviatedUnits: boolean
}

export function GuestSection({ label, guests, expanded, onToggle, showSparklines, useAbbreviatedUnits }: Readonly<GuestSectionProps>) {
  const sorted = [...guests].sort((a, b) => a.vmid - b.vmid)

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
          {label} ({guests.length})
        </span>
      </div>

      <Collapse in={expanded} unmountOnExit>
        <div className="bg-[var(--mui-palette-action-hover)] border-b border-[var(--mui-palette-divider)]">
          {/* Column headers */}
          <div className={`${GUEST_GRID} ${BORDER}`}>
            <div className="px-3 py-2 font-semibold text-sm">VMID</div>
            <div className="px-3 py-2 font-semibold text-sm">Name</div>
            <div className="px-3 py-2 font-semibold text-sm">Status</div>
            <div className="py-2"><MetricHeader>CPU</MetricHeader></div>
            <div className="py-2"><MetricHeader>Memory</MetricHeader></div>
            <div className="py-2"><MetricHeader>Net In</MetricHeader></div>
            <div className="py-2"><MetricHeader>Net Out</MetricHeader></div>
          </div>

          {/* Data rows */}
          {sorted.map((vm) => {
            const cpuParts = formatAsPercentParts(vm.cpu, true)
            const memFraction = vm.maxmem > 0 ? vm.mem / vm.maxmem : 0
            const memParts = vm.status === 'running'
              ? formatAsPercentParts(memFraction, true)
              : formatBytesParts(vm.maxmem, false, false)
            const netInParts = formatBytesParts(vm.netin, false, false)
            const netOutParts = formatBytesParts(vm.netout, false, false)

            return (
              <div key={vm.vmid} className={`${GUEST_GRID} items-center ${BORDER} ${ROW_HOVER}`}>
                <div className="px-3 py-2 font-mono text-sm">{vm.vmid}</div>
                <div className="px-3 py-2 font-medium truncate">{vm.name}</div>
                <div className="px-3 py-2">
                  <Chip
                    size="small"
                    variant="filled"
                    color={vm.status === 'running' ? 'success' : 'default'}
                    label={vm.status}
                  />
                </div>
                <div>
                  {vm.status === 'running' ? (
                    <MetricValue value={cpuParts.value} unit={cpuParts.unit} hasDecimals showSparklines={showSparklines} useAbbreviatedUnits={useAbbreviatedUnits} />
                  ) : <MetricValue value={EMPTY_METRIC} unit="" showSparklines={showSparklines} useAbbreviatedUnits={useAbbreviatedUnits} />}
                </div>
                <div>
                  <MetricValue value={memParts.value} unit={memParts.unit} hasDecimals={vm.status === 'running'} showSparklines={showSparklines} useAbbreviatedUnits={useAbbreviatedUnits} />
                </div>
                <div>
                  {vm.status === 'running' ? (
                    <MetricValue value={netInParts.value} unit={netInParts.unit} showSparklines={showSparklines} useAbbreviatedUnits={useAbbreviatedUnits} />
                  ) : <MetricValue value={EMPTY_METRIC} unit="" showSparklines={showSparklines} useAbbreviatedUnits={useAbbreviatedUnits} />}
                </div>
                <div>
                  {vm.status === 'running' ? (
                    <MetricValue value={netOutParts.value} unit={netOutParts.unit} showSparklines={showSparklines} useAbbreviatedUnits={useAbbreviatedUnits} />
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

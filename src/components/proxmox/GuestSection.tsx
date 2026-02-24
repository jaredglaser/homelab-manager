import { Chip } from '@mui/joy'
import { ChevronRight } from 'lucide-react'
import type { GuestRow } from '@/types/proxmox'
import { formatBytes, formatAsPercentParts, formatBytesParts } from '@/formatters/metrics'
import { MetricValue, MetricHeader } from '@/components/shared-table'
import { GUEST_GRID, BORDER, ROW_HOVER } from '@/components/proxmox/constants'

const DASH_CELL = <span className="text-right block px-3">-</span>

interface GuestSectionProps {
  label: string
  guests: GuestRow[]
  expanded: boolean
  onToggle: () => void
}

export function GuestSection({ label, guests, expanded, onToggle }: GuestSectionProps) {
  const sorted = [...guests].sort((a, b) => a.vmid - b.vmid)

  return (
    <>
      {/* Section header row */}
      <div
        onClick={onToggle}
        className={`flex items-center gap-2 pl-10 pr-4 py-2 cursor-pointer ${BORDER} bg-[var(--joy-palette-background-level1)]`}
      >
        <ChevronRight
          size={16}
          className={`transition-transform duration-200 flex-shrink-0 ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="font-semibold text-sm">
          {label} ({guests.length})
        </span>
      </div>

      {expanded && (
        <>
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
            const memParts = formatAsPercentParts(vm.maxmem > 0 ? vm.mem / vm.maxmem : 0, true)
            const netInParts = formatBytesParts(vm.netin, false, false)
            const netOutParts = formatBytesParts(vm.netout, false, false)

            return (
              <div key={vm.vmid} className={`${GUEST_GRID} items-center ${BORDER} ${ROW_HOVER}`}>
                <div className="px-3 py-2 font-mono text-sm">{vm.vmid}</div>
                <div className="px-3 py-2 font-medium truncate">{vm.name}</div>
                <div className="px-3 py-2">
                  <Chip
                    size="sm"
                    variant="soft"
                    color={vm.status === 'running' ? 'success' : 'neutral'}
                  >
                    {vm.status}
                  </Chip>
                </div>
                <div>
                  {vm.status === 'running' ? (
                    <MetricValue value={cpuParts.value} unit={cpuParts.unit} hasDecimals color="cpu" />
                  ) : DASH_CELL}
                </div>
                <div>
                  {vm.status === 'running' ? (
                    <MetricValue value={memParts.value} unit={memParts.unit} hasDecimals color="memory" />
                  ) : (
                    <span className="text-right block px-3">{formatBytes(vm.maxmem, false, false)}</span>
                  )}
                </div>
                <div>
                  {vm.status === 'running' ? (
                    <MetricValue value={netInParts.value} unit={netInParts.unit} />
                  ) : DASH_CELL}
                </div>
                <div>
                  {vm.status === 'running' ? (
                    <MetricValue value={netOutParts.value} unit={netOutParts.unit} />
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

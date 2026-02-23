import { useMemo } from 'react'
import { Sheet, Chip, LinearProgress } from '@mui/joy'
import { ChevronRight, Server } from 'lucide-react'
import type { ProxmoxClusterOverview, ProxmoxStorage } from '@/types/proxmox'
import { formatBytes, formatAsPercentParts, formatBytesParts } from '@/formatters/metrics'
import { MetricValue, MetricHeader } from '@/components/shared-table'
import { useSettings } from '@/hooks/useSettings'

const GUEST_GRID = 'grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,0.6fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] min-w-[800px]'
const STORAGE_GRID = 'grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,0.6fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,2fr)] min-w-[800px]'
const BORDER = 'border-t border-neutral-200 dark:border-neutral-700'

interface ProxmoxHostViewProps {
  overview: ProxmoxClusterOverview
}

type GuestRow = {
  vmid: number
  name: string
  status: string
  cpu: number
  cpus: number
  mem: number
  maxmem: number
  netin: number
  netout: number
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function GuestSection({
  label,
  guests,
  expanded,
  onToggle,
}: {
  label: string
  guests: GuestRow[]
  expanded: boolean
  onToggle: () => void
}) {
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
              <div key={vm.vmid} className={`${GUEST_GRID} items-center ${BORDER} hover:bg-blue-500/5 hover:shadow-[inset_0_0_0_1px_rgba(59,130,246,0.3)] transition-[background-color,box-shadow] duration-150`}>
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
                  ) : (
                    <span className="text-right block px-3">-</span>
                  )}
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
                  ) : (
                    <span className="text-right block px-3">-</span>
                  )}
                </div>
                <div>
                  {vm.status === 'running' ? (
                    <MetricValue value={netOutParts.value} unit={netOutParts.unit} />
                  ) : (
                    <span className="text-right block px-3">-</span>
                  )}
                </div>
              </div>
            )
          })}
        </>
      )}
    </>
  )
}

function StorageSection({
  storages,
  expanded,
  onToggle,
}: {
  storages: ProxmoxStorage[]
  expanded: boolean
  onToggle: () => void
}) {
  const sorted = [...storages].sort((a, b) => a.storage.localeCompare(b.storage))

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
              <div key={s.storage} className={`${STORAGE_GRID} items-center ${BORDER} hover:bg-blue-500/5 hover:shadow-[inset_0_0_0_1px_rgba(59,130,246,0.3)] transition-[background-color,box-shadow] duration-150`}>
                <div className="px-3 py-2 font-medium">{s.storage}</div>
                <div className="px-3 py-2 text-sm">{s.type}</div>
                <div className="px-3 py-2">
                  <Chip
                    size="sm"
                    variant="soft"
                    color={s.active ? 'success' : 'neutral'}
                  >
                    {s.active ? 'active' : 'inactive'}
                  </Chip>
                </div>
                <div>
                  {s.total > 0 ? (
                    <MetricValue value={usedParts.value} unit={usedParts.unit} />
                  ) : (
                    <span className="text-right block px-3">-</span>
                  )}
                </div>
                <div>
                  {s.total > 0 ? (
                    <MetricValue value={availParts.value} unit={availParts.unit} />
                  ) : (
                    <span className="text-right block px-3">-</span>
                  )}
                </div>
                <div>
                  {s.total > 0 ? (
                    <MetricValue
                      value={usageParts.value}
                      unit={usageParts.unit}
                      hasDecimals
                      sparkline={
                        <LinearProgress
                          determinate
                          value={Math.min(s.used_fraction * 100, 100)}
                          color={
                            s.used_fraction > 0.9
                              ? 'danger'
                              : s.used_fraction > 0.7
                                ? 'warning'
                                : 'success'
                          }
                          className="max-w-70"
                        />
                      }
                    />
                  ) : (
                    <span className="text-right block px-3">-</span>
                  )}
                </div>
              </div>
            )
          })}
        </>
      )}
    </>
  )
}

export default function ProxmoxHostView({ overview }: ProxmoxHostViewProps) {
  const {
    isProxmoxHostExpanded,
    toggleProxmoxHostExpanded,
    isProxmoxSectionExpanded,
    toggleProxmoxSectionExpanded,
    proxmox: { expandedHosts, expandedSections },
  } = useSettings()

  // On first render with no saved expansion state, default to all expanded
  const hasExpansionState = expandedHosts.size > 0 || expandedSections.size > 0

  // Group data by node (memoized to avoid recomputing on expansion toggles)
  const { vmsByNode, containersByNode, storageByNode, sortedNodes } = useMemo(() => {
    const vms = new Map<string, GuestRow[]>()
    const cts = new Map<string, GuestRow[]>()
    const storage = new Map<string, ProxmoxStorage[]>()

    for (const vm of overview.vms) {
      if (!vms.has(vm.node)) vms.set(vm.node, [])
      vms.get(vm.node)!.push({
        vmid: vm.vmid,
        name: vm.name,
        status: vm.status,
        cpu: vm.cpu,
        cpus: vm.cpus,
        mem: vm.mem,
        maxmem: vm.maxmem,
        netin: vm.netin,
        netout: vm.netout,
      })
    }

    for (const ct of overview.containers) {
      if (!cts.has(ct.node)) cts.set(ct.node, [])
      cts.get(ct.node)!.push({
        vmid: ct.vmid,
        name: ct.name,
        status: ct.status,
        cpu: ct.cpu,
        cpus: ct.cpus,
        mem: ct.mem,
        maxmem: ct.maxmem,
        netin: ct.netin,
        netout: ct.netout,
      })
    }

    for (const s of overview.storages) {
      if (!storage.has(s.node)) storage.set(s.node, [])
      storage.get(s.node)!.push(s)
    }

    const sorted = [...overview.nodes].sort((a, b) => a.node.localeCompare(b.node))

    return { vmsByNode: vms, containersByNode: cts, storageByNode: storage, sortedNodes: sorted }
  }, [overview.vms, overview.containers, overview.storages, overview.nodes])

  return (
    <Sheet variant="outlined" className="rounded-sm overflow-x-auto">
      {sortedNodes.map((node, nodeIdx) => {
        const vms = vmsByNode.get(node.node) || []
        const containers = containersByNode.get(node.node) || []
        const storages = storageByNode.get(node.node) || []
        const hostExpanded = hasExpansionState ? isProxmoxHostExpanded(node.node) : true

        const cpuPercent = (node.cpu * 100).toFixed(1)
        const memPercent = node.maxmem > 0 ? ((node.mem / node.maxmem) * 100).toFixed(1) : '0'
        const diskPercent = node.maxdisk > 0 ? ((node.disk / node.maxdisk) * 100).toFixed(1) : '0'

        return (
          <div key={node.node}>
            {/* Host accordion row */}
            <div
              onClick={() => toggleProxmoxHostExpanded(node.node)}
              className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer bg-[var(--joy-palette-background-level1)] ${
                nodeIdx > 0 ? BORDER : ''
              }`}
            >
              <ChevronRight
                size={18}
                className={`transition-transform duration-200 flex-shrink-0 ${hostExpanded ? 'rotate-90' : ''}`}
              />
              <Server size={18} className="flex-shrink-0" />
              <span className="font-bold">{node.node}</span>
              <Chip
                size="sm"
                variant="soft"
                color={node.status === 'online' ? 'success' : 'danger'}
              >
                {node.status}
              </Chip>
              <div className="ml-auto flex items-center gap-4 text-sm font-mono">
                <span>CPU: {cpuPercent}%</span>
                <span>Mem: {memPercent}%</span>
                <span>Disk: {diskPercent}%</span>
                <span className="text-neutral-500">
                  {node.status === 'online' ? formatUptime(node.uptime) : '-'}
                </span>
              </div>
            </div>

            {/* Expanded sections */}
            {hostExpanded && (
              <>
                {vms.length > 0 && (
                  <GuestSection
                    label="Virtual Machines"
                    guests={vms}
                    expanded={hasExpansionState ? isProxmoxSectionExpanded(`${node.node}-vm`) : true}
                    onToggle={() => toggleProxmoxSectionExpanded(`${node.node}-vm`)}
                  />
                )}

                {containers.length > 0 && (
                  <GuestSection
                    label="LXC Containers"
                    guests={containers}
                    expanded={hasExpansionState ? isProxmoxSectionExpanded(`${node.node}-ct`) : true}
                    onToggle={() => toggleProxmoxSectionExpanded(`${node.node}-ct`)}
                  />
                )}

                {storages.length > 0 && (
                  <StorageSection
                    storages={storages}
                    expanded={hasExpansionState ? isProxmoxSectionExpanded(`${node.node}-storage`) : true}
                    onToggle={() => toggleProxmoxSectionExpanded(`${node.node}-storage`)}
                  />
                )}
              </>
            )}
          </div>
        )
      })}
    </Sheet>
  )
}

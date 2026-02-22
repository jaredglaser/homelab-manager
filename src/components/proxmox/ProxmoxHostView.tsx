import { useState } from 'react'
import { Sheet, Typography, IconButton, Chip, LinearProgress } from '@mui/joy'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ProxmoxClusterOverview, ProxmoxStorage } from '@/types/proxmox'
import { formatBytes, formatAsPercentParts, formatBytesParts } from '@/formatters/metrics'
import { MetricValue, MetricHeader } from '@/components/shared-table'

// Shared grid templates for consistent column alignment
// VM/Container: VMID (0.5fr) + Name (2fr) + Status (0.6fr) + CPU (0.8fr) + Memory (1fr) + Net In (0.8fr) + Net Out (0.8fr)
const VM_GRID = 'grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,0.6fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] min-w-[800px]'
// Storage: Aligns with VM columns, Usage spans Net In + Net Out for larger progress bar
const STORAGE_GRID = 'grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,0.6fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,2fr)] min-w-[800px]'

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

function VMTable({ vms }: { vms: GuestRow[] }) {
  if (vms.length === 0) return null

  const sorted = [...vms].sort((a, b) => a.vmid - b.vmid)

  return (
    <Sheet variant="outlined" className="rounded-sm overflow-x-auto">
      {/* Column headers */}
      <div className={`${VM_GRID} border-b border-neutral-200 dark:border-neutral-700`}>
        <div className="px-3 py-2 font-semibold text-sm">VMID</div>
        <div className="px-3 py-2 font-semibold text-sm">Name</div>
        <div className="px-3 py-2 font-semibold text-sm">Status</div>
        <div className="px-3 py-2"><MetricHeader>CPU</MetricHeader></div>
        <div className="px-3 py-2"><MetricHeader>Memory</MetricHeader></div>
        <div className="px-3 py-2"><MetricHeader>Net In</MetricHeader></div>
        <div className="px-3 py-2"><MetricHeader>Net Out</MetricHeader></div>
      </div>

      {/* Data rows */}
      {sorted.map((vm) => {
          const cpuParts = formatAsPercentParts(vm.cpu, true)
          const memParts = formatAsPercentParts(vm.maxmem > 0 ? vm.mem / vm.maxmem : 0, true)
          const netInParts = formatBytesParts(vm.netin, false, false)
          const netOutParts = formatBytesParts(vm.netout, false, false)

          return (
            <div key={vm.vmid} className={`${VM_GRID} border-t border-neutral-200 dark:border-neutral-700`}>
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
              <div className="px-3 py-2">
                {vm.status === 'running' ? (
                  <MetricValue value={cpuParts.value} unit={cpuParts.unit} hasDecimals color="cpu" />
                ) : (
                  <span className="text-right block">-</span>
                )}
              </div>
              <div className="px-3 py-2">
                {vm.status === 'running' ? (
                  <MetricValue value={memParts.value} unit={memParts.unit} hasDecimals color="memory" />
                ) : (
                  <span className="text-right block">{formatBytes(vm.maxmem, false, false)}</span>
                )}
              </div>
              <div className="px-3 py-2">
                {vm.status === 'running' ? (
                  <MetricValue value={netInParts.value} unit={netInParts.unit} />
                ) : (
                  <span className="text-right block">-</span>
                )}
              </div>
              <div className="px-3 py-2">
                {vm.status === 'running' ? (
                  <MetricValue value={netOutParts.value} unit={netOutParts.unit} />
                ) : (
                  <span className="text-right block">-</span>
                )}
              </div>
            </div>
          )
        })}
    </Sheet>
  )
}

function StorageTable({ storages }: { storages: ProxmoxStorage[] }) {
  if (storages.length === 0) return null

  const sorted = [...storages].sort((a, b) => a.storage.localeCompare(b.storage))

  return (
    <Sheet variant="outlined" className="rounded-sm overflow-x-auto">
      {/* Column headers */}
      <div className={`${STORAGE_GRID} border-b border-neutral-200 dark:border-neutral-700`}>
        <div className="px-3 py-2 font-semibold text-sm">Name</div>
        <div className="px-3 py-2 font-semibold text-sm">Type</div>
        <div className="px-3 py-2 font-semibold text-sm">Status</div>
        <div className="px-3 py-2"><MetricHeader>Used</MetricHeader></div>
        <div className="px-3 py-2"><MetricHeader>Available</MetricHeader></div>
        <div className="px-3 py-2"><MetricHeader>Usage</MetricHeader></div>
      </div>

      {/* Data rows */}
      {sorted.map((s) => {
          const usedParts = formatBytesParts(s.used, false, false)
          const availParts = formatBytesParts(s.avail, false, false)
          const usageParts = formatAsPercentParts(s.used_fraction, true)

          return (
            <div key={s.storage} className={`${STORAGE_GRID} border-t border-neutral-200 dark:border-neutral-700`}>
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
              <div className="px-3 py-2">
                {s.total > 0 ? (
                  <MetricValue value={usedParts.value} unit={usedParts.unit} />
                ) : (
                  <span className="text-right block">-</span>
                )}
              </div>
              <div className="px-3 py-2">
                {s.total > 0 ? (
                  <MetricValue value={availParts.value} unit={availParts.unit} />
                ) : (
                  <span className="text-right block">-</span>
                )}
              </div>
              <div className="px-3 py-2">
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
                  <span className="text-right block">-</span>
                )}
              </div>
            </div>
          )
        })}
    </Sheet>
  )
}

export default function ProxmoxHostView({ overview }: ProxmoxHostViewProps) {
  // Initialize all hosts and sections as expanded using lazy initializers
  const [expandedHosts, setExpandedHosts] = useState<Set<string>>(() =>
    new Set(overview.nodes.map(n => n.node))
  )
  const [expandedSections, setExpandedSections] = useState<Set<string>>(() => {
    const allSections = overview.nodes.flatMap(n => [
      `${n.node}-vm`,
      `${n.node}-ct`,
      `${n.node}-storage`
    ])
    return new Set(allSections)
  })

  // Group data by node
  const vmsByNode = new Map<string, GuestRow[]>()
  const containersByNode = new Map<string, GuestRow[]>()
  const storageByNode = new Map<string, ProxmoxStorage[]>()

  for (const vm of overview.vms) {
    if (!vmsByNode.has(vm.node)) vmsByNode.set(vm.node, [])
    vmsByNode.get(vm.node)!.push({
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
    if (!containersByNode.has(ct.node)) containersByNode.set(ct.node, [])
    containersByNode.get(ct.node)!.push({
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

  for (const storage of overview.storages) {
    if (!storageByNode.has(storage.node)) storageByNode.set(storage.node, [])
    storageByNode.get(storage.node)!.push(storage)
  }

  // Sort nodes alphabetically
  const sortedNodes = [...overview.nodes].sort((a, b) => a.node.localeCompare(b.node))

  const toggleHost = (node: string) => {
    setExpandedHosts(prev => {
      const next = new Set(prev)
      if (next.has(node)) {
        next.delete(node)
      } else {
        next.add(node)
      }
      return next
    })
  }

  const toggleSection = (key: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  return (
    <div className="space-y-4">
      {sortedNodes.map((node) => {
        const vms = vmsByNode.get(node.node) || []
        const containers = containersByNode.get(node.node) || []
        const storages = storageByNode.get(node.node) || []
        const isHostExpanded = expandedHosts.has(node.node)

        const cpuPercent = (node.cpu * 100).toFixed(1)
        const memPercent = node.maxmem > 0 ? ((node.mem / node.maxmem) * 100).toFixed(1) : '0'
        const diskPercent = node.maxdisk > 0 ? ((node.disk / node.maxdisk) * 100).toFixed(1) : '0'

        return (
          <div key={node.node} className="space-y-3">
            {/* Host Header */}
            <Sheet
              variant="soft"
              className="rounded-lg cursor-pointer hover:bg-opacity-80 transition-colors"
              onClick={() => toggleHost(node.node)}
            >
              <div className="flex items-center gap-3 px-4 py-3">
                <IconButton
                  size="sm"
                  variant="plain"
                  color="neutral"
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleHost(node.node)
                  }}
                >
                  {isHostExpanded ? (
                    <ChevronDown size={20} />
                  ) : (
                    <ChevronRight size={20} />
                  )}
                </IconButton>
                <div className="flex items-center gap-4 flex-1">
                  <Typography level="title-md" className="font-semibold">
                    {node.node}
                  </Typography>
                  <Chip
                    size="sm"
                    variant="soft"
                    color={node.status === 'online' ? 'success' : 'danger'}
                  >
                    {node.status}
                  </Chip>
                </div>
                <div className="flex items-center gap-4 text-sm font-mono">
                  <span>CPU: {cpuPercent}%</span>
                  <span>Mem: {memPercent}%</span>
                  <span>Disk: {diskPercent}%</span>
                  <span className="text-neutral-500">{node.status === 'online' ? formatUptime(node.uptime) : '-'}</span>
                </div>
              </div>
            </Sheet>

            {/* Host Sections */}
            {isHostExpanded && (
              <div className="ml-8 space-y-3">
                {/* Virtual Machines */}
                {vms.length > 0 && (
                  <div>
                    <Sheet
                      variant="soft"
                      className="rounded-sm cursor-pointer hover:bg-opacity-80 transition-colors"
                      onClick={() => toggleSection(`${node.node}-vm`)}
                    >
                      <div className="flex items-center gap-2 px-3 py-2">
                        <IconButton
                          size="sm"
                          variant="plain"
                          color="neutral"
                          onClick={(e) => {
                            e.stopPropagation()
                            toggleSection(`${node.node}-vm`)
                          }}
                        >
                          {expandedSections.has(`${node.node}-vm`) ? (
                            <ChevronDown size={16} />
                          ) : (
                            <ChevronRight size={16} />
                          )}
                        </IconButton>
                        <Typography level="title-sm" className="font-semibold">
                          Virtual Machines ({vms.length})
                        </Typography>
                      </div>
                    </Sheet>
                    {expandedSections.has(`${node.node}-vm`) && (
                      <div className="mt-2">
                        <VMTable vms={vms} />
                      </div>
                    )}
                  </div>
                )}

                {/* LXC Containers */}
                {containers.length > 0 && (
                  <div>
                    <Sheet
                      variant="soft"
                      className="rounded-sm cursor-pointer hover:bg-opacity-80 transition-colors"
                      onClick={() => toggleSection(`${node.node}-ct`)}
                    >
                      <div className="flex items-center gap-2 px-3 py-2">
                        <IconButton
                          size="sm"
                          variant="plain"
                          color="neutral"
                          onClick={(e) => {
                            e.stopPropagation()
                            toggleSection(`${node.node}-ct`)
                          }}
                        >
                          {expandedSections.has(`${node.node}-ct`) ? (
                            <ChevronDown size={16} />
                          ) : (
                            <ChevronRight size={16} />
                          )}
                        </IconButton>
                        <Typography level="title-sm" className="font-semibold">
                          LXC Containers ({containers.length})
                        </Typography>
                      </div>
                    </Sheet>
                    {expandedSections.has(`${node.node}-ct`) && (
                      <div className="mt-2">
                        <VMTable vms={containers} />
                      </div>
                    )}
                  </div>
                )}

                {/* Storage */}
                {storages.length > 0 && (
                  <div>
                    <Sheet
                      variant="soft"
                      className="rounded-sm cursor-pointer hover:bg-opacity-80 transition-colors"
                      onClick={() => toggleSection(`${node.node}-storage`)}
                    >
                      <div className="flex items-center gap-2 px-3 py-2">
                        <IconButton
                          size="sm"
                          variant="plain"
                          color="neutral"
                          onClick={(e) => {
                            e.stopPropagation()
                            toggleSection(`${node.node}-storage`)
                          }}
                        >
                          {expandedSections.has(`${node.node}-storage`) ? (
                            <ChevronDown size={16} />
                          ) : (
                            <ChevronRight size={16} />
                          )}
                        </IconButton>
                        <Typography level="title-sm" className="font-semibold">
                          Storage ({storages.length})
                        </Typography>
                      </div>
                    </Sheet>
                    {expandedSections.has(`${node.node}-storage`) && (
                      <div className="mt-2">
                        <StorageTable storages={storages} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

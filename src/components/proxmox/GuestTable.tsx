import { useState } from 'react'
import { Sheet, Typography } from '@mui/joy'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ProxmoxVM, ProxmoxContainer } from '@/types/proxmox'
import { formatBytes } from '@/formatters/metrics'

type GuestVM = ProxmoxVM & { node: string }
type GuestCT = ProxmoxContainer & { node: string }

interface GuestTableProps {
  vms: GuestVM[]
  containers: GuestCT[]
}

type GuestRow = {
  type: 'vm' | 'ct'
  vmid: number
  name: string
  node: string
  status: string
  cpu: number
  cpus: number
  mem: number
  maxmem: number
  uptime: number
  netin: number
  netout: number
}

function toRow(vm: GuestVM): GuestRow
function toRow(ct: GuestCT): GuestRow
function toRow(g: GuestVM | GuestCT): GuestRow {
  return {
    type: 'cpus' in g && !('swap' in g) ? 'vm' : 'ct',
    vmid: g.vmid,
    name: g.name,
    node: g.node,
    status: g.status,
    cpu: g.cpu,
    cpus: g.cpus,
    mem: g.mem,
    maxmem: g.maxmem,
    uptime: g.uptime,
    netin: g.netin,
    netout: g.netout,
  }
}

function GuestSubTable({ guests }: { guests: GuestRow[] }) {
  if (guests.length === 0) return null

  const sortedGuests = [...guests].sort((a, b) => a.vmid - b.vmid)

  return (
    <Sheet variant="outlined" className="rounded-sm overflow-hidden">
      <div
        className="grid"
        style={{ gridTemplateColumns: '0.5fr 2fr 0.6fr 0.8fr 1fr 0.8fr 0.8fr' }}
      >
        {/* Header */}
        <div className="px-3 py-2 font-semibold text-sm border-b border-neutral-200 dark:border-neutral-700">VMID</div>
        <div className="px-3 py-2 font-semibold text-sm border-b border-neutral-200 dark:border-neutral-700">Name</div>
        <div className="px-3 py-2 font-semibold text-sm border-b border-neutral-200 dark:border-neutral-700">Status</div>
        <div className="px-3 py-2 font-semibold text-sm border-b border-neutral-200 dark:border-neutral-700 text-right">CPU</div>
        <div className="px-3 py-2 font-semibold text-sm border-b border-neutral-200 dark:border-neutral-700 text-right">Memory</div>
        <div className="px-3 py-2 font-semibold text-sm border-b border-neutral-200 dark:border-neutral-700 text-right">Net In</div>
        <div className="px-3 py-2 font-semibold text-sm border-b border-neutral-200 dark:border-neutral-700 text-right">Net Out</div>

        {/* Rows */}
        {sortedGuests.map((guest) => {
          const cpuPercent = (guest.cpu * 100).toFixed(1)
          const memPercent = guest.maxmem > 0 ? ((guest.mem / guest.maxmem) * 100).toFixed(1) : '0'

          return (
            <div key={`${guest.type}-${guest.vmid}`} className="contents">
              <div className="px-3 py-2 font-mono text-sm border-b border-neutral-200 dark:border-neutral-700">{guest.vmid}</div>
              <div className="px-3 py-2 font-medium truncate border-b border-neutral-200 dark:border-neutral-700">{guest.name}</div>
              <div className="px-3 py-2 border-b border-neutral-200 dark:border-neutral-700">
                <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                  guest.status === 'running'
                    ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                    : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
                }`}>
                  {guest.status}
                </span>
              </div>
              <div className="px-3 py-2 text-right font-mono text-sm border-b border-neutral-200 dark:border-neutral-700">
                {guest.status === 'running' ? `${cpuPercent}%` : '-'}
              </div>
              <div className="px-3 py-2 text-right font-mono text-sm border-b border-neutral-200 dark:border-neutral-700">
                {guest.status === 'running'
                  ? <>{memPercent}% <span className="text-neutral-400">({formatBytes(guest.maxmem, false, false)})</span></>
                  : formatBytes(guest.maxmem, false, false)
                }
              </div>
              <div className="px-3 py-2 text-right font-mono text-sm border-b border-neutral-200 dark:border-neutral-700">
                {guest.status === 'running' ? formatBytes(guest.netin, false, false) : '-'}
              </div>
              <div className="px-3 py-2 text-right font-mono text-sm border-b border-neutral-200 dark:border-neutral-700">
                {guest.status === 'running' ? formatBytes(guest.netout, false, false) : '-'}
              </div>
            </div>
          )
        })}
      </div>
    </Sheet>
  )
}

export default function GuestTable({ vms, containers }: GuestTableProps) {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set())

  const allVMs = vms.map((vm) => toRow(vm))
  const allContainers = containers.map((ct) => toRow(ct))

  if (allVMs.length === 0 && allContainers.length === 0) {
    return (
      <div className="mb-6">
        <Typography level="title-lg" className="mb-3">Guests</Typography>
        <Typography level="body-sm" className="text-neutral-500">No VMs or containers found.</Typography>
      </div>
    )
  }

  // Group VMs and containers by node
  const vmsByNode = new Map<string, GuestRow[]>()
  const containersByNode = new Map<string, GuestRow[]>()

  for (const vm of allVMs) {
    if (!vmsByNode.has(vm.node)) {
      vmsByNode.set(vm.node, [])
    }
    vmsByNode.get(vm.node)!.push(vm)
  }

  for (const ct of allContainers) {
    if (!containersByNode.has(ct.node)) {
      containersByNode.set(ct.node, [])
    }
    containersByNode.get(ct.node)!.push(ct)
  }

  // Get all unique nodes and sort
  const allNodes = new Set([...vmsByNode.keys(), ...containersByNode.keys()])
  const sortedNodes = Array.from(allNodes).sort((a, b) => a.localeCompare(b))

  // Initialize all sections as expanded
  const allSectionKeys = sortedNodes.flatMap(node => [
    `${node}-vm`,
    `${node}-ct`
  ])

  if (expandedSections.size === 0) {
    setExpandedSections(new Set(allSectionKeys))
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
    <div className="mb-6">
      <Typography level="title-lg" className="mb-3">
        Guests ({allVMs.length + allContainers.length})
      </Typography>
      <div className="space-y-4">
        {sortedNodes.map((node) => {
          const nodeVMs = vmsByNode.get(node) || []
          const nodeContainers = containersByNode.get(node) || []
          const vmKey = `${node}-vm`
          const ctKey = `${node}-ct`

          return (
            <div key={node} className="space-y-3">
              {/* Virtual Machines Section */}
              {nodeVMs.length > 0 && (
                <div>
                  <button
                    onClick={() => toggleSection(vmKey)}
                    className="w-full flex items-center gap-2 px-3 py-2 bg-neutral-50 dark:bg-neutral-800 rounded-sm hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
                  >
                    {expandedSections.has(vmKey) ? (
                      <ChevronDown size={16} className="text-neutral-600 dark:text-neutral-400" />
                    ) : (
                      <ChevronRight size={16} className="text-neutral-600 dark:text-neutral-400" />
                    )}
                    <Typography level="title-sm" className="font-semibold">
                      {node} - Virtual Machines ({nodeVMs.length})
                    </Typography>
                  </button>
                  {expandedSections.has(vmKey) && (
                    <div className="mt-2">
                      <GuestSubTable guests={nodeVMs} />
                    </div>
                  )}
                </div>
              )}

              {/* LXC Containers Section */}
              {nodeContainers.length > 0 && (
                <div>
                  <button
                    onClick={() => toggleSection(ctKey)}
                    className="w-full flex items-center gap-2 px-3 py-2 bg-neutral-50 dark:bg-neutral-800 rounded-sm hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
                  >
                    {expandedSections.has(ctKey) ? (
                      <ChevronDown size={16} className="text-neutral-600 dark:text-neutral-400" />
                    ) : (
                      <ChevronRight size={16} className="text-neutral-600 dark:text-neutral-400" />
                    )}
                    <Typography level="title-sm" className="font-semibold">
                      {node} - LXC Containers ({nodeContainers.length})
                    </Typography>
                  </button>
                  {expandedSections.has(ctKey) && (
                    <div className="mt-2">
                      <GuestSubTable guests={nodeContainers} />
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

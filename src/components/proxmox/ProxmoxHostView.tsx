import { useMemo } from 'react'
import { Paper, Chip, Collapse } from '@mui/material'
import { ChevronRight, Server } from 'lucide-react'
import type { ProxmoxClusterOverview, GuestRow } from '@/types/proxmox'
import { useSettings } from '@/hooks/useSettings'
import { EMPTY_METRIC } from '@/components/shared-table'
import { BORDER } from '@/components/proxmox/constants'
import { formatUptime } from '@/components/proxmox/utils'
import { GuestSection } from '@/components/proxmox/GuestSection'
import { StorageSection } from '@/components/proxmox/StorageSection'

interface ProxmoxHostViewProps {
  overview: ProxmoxClusterOverview
}

export default function ProxmoxHostView({ overview }: ProxmoxHostViewProps) {
  const {
    isProxmoxHostExpanded,
    toggleProxmoxHostExpanded,
    isProxmoxSectionExpanded,
    toggleProxmoxSectionExpanded,
    proxmox: { expandedHosts, expandedSections },
    general: { showSparklines, useAbbreviatedUnits },
  } = useSettings()

  // On first render with no saved expansion state, default to all expanded
  const hasExpansionState = expandedHosts.size > 0 || expandedSections.size > 0

  // Group data by node (memoized to avoid recomputing on expansion toggles)
  const { vmsByNode, containersByNode, storageByNode, sortedNodes } = useMemo(() => {
    const vms = new Map<string, GuestRow[]>()
    const cts = new Map<string, GuestRow[]>()
    const storage = new Map<string, (typeof overview.storages)[number][]>()

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
    <Paper variant="outlined" className="rounded-sm overflow-x-auto">
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
              className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors duration-150 ${
                nodeIdx > 0 ? BORDER : ''
              } ${hostExpanded ? 'bg-[var(--mui-palette-action-hover)]' : 'bg-[var(--mui-palette-background-level2)]'}`}
            >
              <ChevronRight
                size={18}
                className={`transition-transform duration-200 flex-shrink-0 ${hostExpanded ? 'rotate-90' : ''}`}
              />
              <Server size={18} className="flex-shrink-0" />
              <span className="font-bold">{node.node}</span>
              <Chip
                size="small"
                variant="filled"
                color={node.status === 'online' ? 'success' : 'error'}
                label={node.status}
              />
              <div className="ml-auto flex items-center gap-4 text-sm tabular-nums">
                <span>CPU: {cpuPercent}%</span>
                <span>Mem: {memPercent}%</span>
                <span>Disk: {diskPercent}%</span>
                <span className="text-neutral-500">
                  {node.status === 'online' ? formatUptime(node.uptime) : EMPTY_METRIC}
                </span>
              </div>
            </div>

            {/* Expanded sections */}
            <Collapse in={hostExpanded} unmountOnExit>
              {vms.length > 0 && (
                <GuestSection
                  label="Virtual Machines"
                  guests={vms}
                  expanded={hasExpansionState ? isProxmoxSectionExpanded(`${node.node}-vm`) : true}
                  onToggle={() => toggleProxmoxSectionExpanded(`${node.node}-vm`)}
                  showSparklines={showSparklines}
                  useAbbreviatedUnits={useAbbreviatedUnits}
                />
              )}

              {containers.length > 0 && (
                <GuestSection
                  label="LXC Containers"
                  guests={containers}
                  expanded={hasExpansionState ? isProxmoxSectionExpanded(`${node.node}-ct`) : true}
                  onToggle={() => toggleProxmoxSectionExpanded(`${node.node}-ct`)}
                  showSparklines={showSparklines}
                  useAbbreviatedUnits={useAbbreviatedUnits}
                />
              )}

              {storages.length > 0 && (
                <StorageSection
                  storages={storages}
                  expanded={hasExpansionState ? isProxmoxSectionExpanded(`${node.node}-storage`) : true}
                  onToggle={() => toggleProxmoxSectionExpanded(`${node.node}-storage`)}
                  showSparklines={showSparklines}
                  useAbbreviatedUnits={useAbbreviatedUnits}
                />
              )}
            </Collapse>
          </div>
        )
      })}
    </Paper>
  )
}

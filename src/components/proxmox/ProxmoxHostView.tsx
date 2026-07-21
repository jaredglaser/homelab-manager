import { useMemo } from 'react'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { ChevronRight, Server } from 'lucide-react'
import type { ProxmoxClusterOverview, GuestRow } from '@/types/proxmox'
import { useGeneralSettings, useProxmoxSettings } from '@/hooks/useSettings'
import { EMPTY_METRIC } from '@/components/ui/datatable/MetricCell'
import { formatUptime } from '@/components/proxmox/utils'
import { GuestSection } from '@/components/proxmox/GuestSection'
import { StorageSection } from '@/components/proxmox/StorageSection'

interface ProxmoxHostViewProps {
  overview: ProxmoxClusterOverview
}

export default function ProxmoxHostView({ overview }: Readonly<ProxmoxHostViewProps>) {
  const {
    isProxmoxHostExpanded,
    toggleProxmoxHostExpanded,
    isProxmoxSectionExpanded,
    toggleProxmoxSectionExpanded,
  } = useProxmoxSettings()
  const { general: { showSparklines, useAbbreviatedUnits } } = useGeneralSettings()

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
    <div className="bg-card border border-border rounded-sm overflow-x-auto">
      {sortedNodes.map((node, nodeIdx) => {
        const vms = vmsByNode.get(node.node) || []
        const containers = containersByNode.get(node.node) || []
        const storages = storageByNode.get(node.node) || []
        const hostExpanded = isProxmoxHostExpanded(node.node)

        const cpuPercent = (node.cpu * 100).toFixed(1)
        const memPercent = node.maxmem > 0 ? ((node.mem / node.maxmem) * 100).toFixed(1) : '0'
        const diskPercent = node.maxdisk > 0 ? ((node.disk / node.maxdisk) * 100).toFixed(1) : '0'

        return (
          <div key={node.node}>
            {/* Host accordion row */}
            <div
              role="button"
              tabIndex={0}
              aria-expanded={hostExpanded}
              aria-controls={`proxmox-host-panel-${node.node}`}
              onClick={() => toggleProxmoxHostExpanded(node.node)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleProxmoxHostExpanded(node.node); } }}
              className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors duration-150 ${
                nodeIdx > 0 ? 'border-t border-(--border)' : ''
              } ${hostExpanded ? 'bg-(--accent)' : 'bg-(--level2)'}`}
            >
              <ChevronRight
                size={18}
                className={`transition-transform duration-200 shrink-0 ${hostExpanded ? 'rotate-90' : ''}`}
              />
              <Server size={18} className="shrink-0" />
              <span className="font-bold">{node.node}</span>
              <Badge variant={node.status === 'online' ? 'success' : 'destructive'}>
                {node.status}
              </Badge>
              <div className="ml-auto flex items-center gap-4 text-sm tabular-nums">
                <span>CPU: {cpuPercent}%</span>
                <span>Mem: {memPercent}%</span>
                <span>Disk: {diskPercent}%</span>
                <span className="text-(--muted-foreground)">
                  {node.status === 'online' ? formatUptime(node.uptime) : EMPTY_METRIC}
                </span>
              </div>
            </div>

            {/* Expanded sections */}
            <Collapsible open={hostExpanded}>
            <CollapsibleContent id={`proxmox-host-panel-${node.node}`}>
              {vms.length > 0 && (
                <GuestSection
                  label="Virtual Machines"
                  guests={vms}
                  expanded={isProxmoxSectionExpanded(`${node.node}-vm`)}
                  onToggle={() => toggleProxmoxSectionExpanded(`${node.node}-vm`)}
                  showSparklines={showSparklines}
                  useAbbreviatedUnits={useAbbreviatedUnits}
                />
              )}

              {containers.length > 0 && (
                <GuestSection
                  label="LXC Containers"
                  guests={containers}
                  expanded={isProxmoxSectionExpanded(`${node.node}-ct`)}
                  onToggle={() => toggleProxmoxSectionExpanded(`${node.node}-ct`)}
                  showSparklines={showSparklines}
                  useAbbreviatedUnits={useAbbreviatedUnits}
                />
              )}

              {storages.length > 0 && (
                <StorageSection
                  storages={storages}
                  expanded={isProxmoxSectionExpanded(`${node.node}-storage`)}
                  onToggle={() => toggleProxmoxSectionExpanded(`${node.node}-storage`)}
                  showSparklines={showSparklines}
                  useAbbreviatedUnits={useAbbreviatedUnits}
                />
              )}
            </CollapsibleContent>
            </Collapsible>
          </div>
        )
      })}
    </div>
  )
}

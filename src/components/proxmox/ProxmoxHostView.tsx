import { useMemo } from 'react'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { ChevronRight, Server } from 'lucide-react'
import type { ProxmoxClusterOverview, ProxmoxGuest, ProxmoxStorage, GuestRow } from '@/types/proxmox'
import { useGeneralSettings, useProxmoxSettings } from '@/hooks/useSettings'
import { EMPTY_CELL } from '@/components/ui/table'
import { formatUptime } from '@/components/proxmox/utils'
import { GuestSection } from '@/components/proxmox/GuestSection'
import { StorageSection } from '@/components/proxmox/StorageSection'

interface ProxmoxHostViewProps {
  overview: ProxmoxClusterOverview
}

/** Expansion and grouping key for a node: the connection's host plus the node name, which repeats across clusters. */
function nodeKey(item: { host: string; node: string }): string {
  return `${item.host}/${item.node}`
}

function toGuestRow(guest: ProxmoxGuest): GuestRow {
  return {
    host: guest.host,
    node: guest.node,
    vmid: guest.vmid,
    name: guest.name,
    status: guest.status,
    cpu: guest.cpu,
    cpus: guest.cpus,
    mem: guest.mem,
    maxmem: guest.maxmem,
    netInBytesPerSec: guest.netInBytesPerSec,
    netOutBytesPerSec: guest.netOutBytesPerSec,
    diskReadBytesPerSec: guest.diskReadBytesPerSec,
    diskWriteBytesPerSec: guest.diskWriteBytesPerSec,
  }
}

export default function ProxmoxHostView({ overview }: Readonly<ProxmoxHostViewProps>) {
  const {
    isProxmoxHostExpanded,
    toggleProxmoxHostExpanded,
    isProxmoxSectionExpanded,
    toggleProxmoxSectionExpanded,
  } = useProxmoxSettings()
  const { general: { showSparklines, useAbbreviatedUnits } } = useGeneralSettings()

  const { vmsByNode, containersByNode, storageByNode, sortedNodes } = useMemo(() => {
    const vms = new Map<string, GuestRow[]>()
    const cts = new Map<string, GuestRow[]>()
    const storage = new Map<string, ProxmoxStorage[]>()
    const push = <T,>(map: Map<string, T[]>, key: string, value: T) => {
      const list = map.get(key)
      if (list) list.push(value)
      else map.set(key, [value])
    }

    for (const vm of overview.vms) push(vms, nodeKey(vm), toGuestRow(vm))
    for (const ct of overview.containers) push(cts, nodeKey(ct), toGuestRow(ct))
    for (const s of overview.storages) push(storage, nodeKey(s), s)

    const sorted = [...overview.nodes].sort((a, b) => a.host.localeCompare(b.host) || a.node.localeCompare(b.node))

    return { vmsByNode: vms, containersByNode: cts, storageByNode: storage, sortedNodes: sorted }
  }, [overview.vms, overview.containers, overview.storages, overview.nodes])

  return (
    <div className="bg-card border border-border rounded-sm overflow-x-auto">
      {sortedNodes.map((node, nodeIdx) => {
        const key = nodeKey(node)
        const vms = vmsByNode.get(key) || []
        const containers = containersByNode.get(key) || []
        const storages = storageByNode.get(key) || []
        const hostExpanded = isProxmoxHostExpanded(key)

        const cpuPercent = (node.cpu * 100).toFixed(1)
        const memPercent = node.maxmem > 0 ? ((node.mem / node.maxmem) * 100).toFixed(1) : '0'
        const diskPercent = node.maxdisk > 0 ? ((node.disk / node.maxdisk) * 100).toFixed(1) : '0'

        return (
          <div key={key}>
            {/* Host accordion row */}
            <div
              role="button"
              tabIndex={0}
              aria-expanded={hostExpanded}
              aria-controls={`proxmox-host-panel-${key}`}
              onClick={() => toggleProxmoxHostExpanded(key)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleProxmoxHostExpanded(key); } }}
              className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors duration-150 ${
                nodeIdx > 0 ? 'border-t border-border' : ''
              } ${hostExpanded ? 'bg-accent' : 'bg-level2'}`}
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
                <span className="text-muted-foreground">
                  {node.status === 'online' ? formatUptime(node.uptime) : EMPTY_CELL}
                </span>
              </div>
            </div>

            {/* Expanded sections */}
            <Collapsible open={hostExpanded}>
            <CollapsibleContent id={`proxmox-host-panel-${key}`}>
              {vms.length > 0 && (
                <GuestSection
                  label="Virtual Machines"
                  guests={vms}
                  expanded={isProxmoxSectionExpanded(`${key}-vm`)}
                  onToggle={() => toggleProxmoxSectionExpanded(`${key}-vm`)}
                  showSparklines={showSparklines}
                  useAbbreviatedUnits={useAbbreviatedUnits}
                />
              )}

              {containers.length > 0 && (
                <GuestSection
                  label="LXC Containers"
                  guests={containers}
                  expanded={isProxmoxSectionExpanded(`${key}-ct`)}
                  onToggle={() => toggleProxmoxSectionExpanded(`${key}-ct`)}
                  showSparklines={showSparklines}
                  useAbbreviatedUnits={useAbbreviatedUnits}
                />
              )}

              {storages.length > 0 && (
                <StorageSection
                  storages={storages}
                  expanded={isProxmoxSectionExpanded(`${key}-storage`)}
                  onToggle={() => toggleProxmoxSectionExpanded(`${key}-storage`)}
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

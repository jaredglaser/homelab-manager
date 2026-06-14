import type { ProxmoxClusterOverview } from '@/types/proxmox'
import { formatBytes } from '@/formatters/metrics'

interface ClusterSummaryCardsProps {
  overview: ProxmoxClusterOverview
}

export default function ClusterSummaryCards({ overview }: ClusterSummaryCardsProps) {
  const { totals, nodes, clusterName } = overview
  const onlineNodes = nodes.filter((n) => n.status === 'online').length
  const cpuPercent = totals.totalCpu > 0 ? (totals.usedCpu / totals.totalCpu) * 100 : 0
  const memPercent = totals.totalMemory > 0 ? (totals.usedMemory / totals.totalMemory) * 100 : 0

  return (
    <div className="grid grid-cols-2 gap-4 mb-6 lg:grid-cols-4">
      <div className="p-4 bg-card rounded-lg border border-border">
        <span className="text-xs uppercase tracking-wide text-(--muted-foreground)">
          Cluster
        </span>
        <h5 className="text-2xl">{clusterName}</h5>
        <p className="text-sm">
          {onlineNodes}/{nodes.length} nodes online
        </p>
      </div>

      <div className="p-4 bg-card rounded-lg border border-border">
        <span className="text-xs uppercase tracking-wide text-(--muted-foreground)">
          CPU
        </span>
        <h5 className="text-2xl">{cpuPercent.toFixed(1)}%</h5>
        <p className="text-sm">
          {totals.usedCpu.toFixed(1)} / {totals.totalCpu} cores
        </p>
      </div>

      <div className="p-4 bg-card rounded-lg border border-border">
        <span className="text-xs uppercase tracking-wide text-(--muted-foreground)">
          Memory
        </span>
        <h5 className="text-2xl">{memPercent.toFixed(1)}%</h5>
        <p className="text-sm">
          {formatBytes(totals.usedMemory, false)} / {formatBytes(totals.totalMemory, false)}
        </p>
      </div>

      <div className="p-4 bg-card rounded-lg border border-border">
        <span className="text-xs uppercase tracking-wide text-(--muted-foreground)">
          Guests
        </span>
        <h5 className="text-2xl">
          {totals.runningVMs + totals.runningContainers} running
        </h5>
        <p className="text-sm">
          {totals.runningVMs} VMs, {totals.runningContainers} CTs
          {(totals.stoppedVMs + totals.stoppedContainers > 0) && (
            <> ({totals.stoppedVMs + totals.stoppedContainers} stopped)</>
          )}
        </p>
      </div>
    </div>
  )
}

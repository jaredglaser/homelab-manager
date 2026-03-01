import { Card, Typography } from '@mui/material'
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
      <Card variant="outlined" className="p-4">
        <Typography variant="caption" className="uppercase tracking-wide text-neutral-500">
          Cluster
        </Typography>
        <Typography variant="h5">{clusterName}</Typography>
        <Typography variant="body2">
          {onlineNodes}/{nodes.length} nodes online
        </Typography>
      </Card>

      <Card variant="outlined" className="p-4">
        <Typography variant="caption" className="uppercase tracking-wide text-neutral-500">
          CPU
        </Typography>
        <Typography variant="h5">{cpuPercent.toFixed(1)}%</Typography>
        <Typography variant="body2">
          {totals.usedCpu.toFixed(1)} / {totals.totalCpu} cores
        </Typography>
      </Card>

      <Card variant="outlined" className="p-4">
        <Typography variant="caption" className="uppercase tracking-wide text-neutral-500">
          Memory
        </Typography>
        <Typography variant="h5">{memPercent.toFixed(1)}%</Typography>
        <Typography variant="body2">
          {formatBytes(totals.usedMemory, false)} / {formatBytes(totals.totalMemory, false)}
        </Typography>
      </Card>

      <Card variant="outlined" className="p-4">
        <Typography variant="caption" className="uppercase tracking-wide text-neutral-500">
          Guests
        </Typography>
        <Typography variant="h5">
          {totals.runningVMs + totals.runningContainers} running
        </Typography>
        <Typography variant="body2">
          {totals.runningVMs} VMs, {totals.runningContainers} CTs
          {(totals.stoppedVMs + totals.stoppedContainers > 0) && (
            <> ({totals.stoppedVMs + totals.stoppedContainers} stopped)</>
          )}
        </Typography>
      </Card>
    </div>
  )
}

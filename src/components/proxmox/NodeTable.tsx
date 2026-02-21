import { Card, Typography } from '@mui/joy'
import type { ProxmoxNode } from '@/types/proxmox'
import { formatBytes } from '@/formatters/metrics'

interface NodeTableProps {
  nodes: ProxmoxNode[]
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export default function NodeTable({ nodes }: NodeTableProps) {
  return (
    <Card variant="outlined" className="mb-6">
      <Typography level="title-lg" className="mb-3">Nodes</Typography>
      <div className="grid gap-px bg-neutral-200 dark:bg-neutral-700 rounded-lg overflow-hidden"
        style={{ gridTemplateColumns: 'minmax(120px, 1fr) 80px 120px 120px 120px 100px' }}
      >
        {/* Header */}
        <div className="bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Node</div>
        <div className="bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Status</div>
        <div className="bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500 text-right">CPU</div>
        <div className="bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500 text-right">Memory</div>
        <div className="bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500 text-right">Disk</div>
        <div className="bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500 text-right">Uptime</div>

        {/* Rows */}
        {nodes.map((node) => {
          const cpuPercent = (node.cpu * 100).toFixed(1)
          const memPercent = node.maxmem > 0 ? ((node.mem / node.maxmem) * 100).toFixed(1) : '0'
          const diskPercent = node.maxdisk > 0 ? ((node.disk / node.maxdisk) * 100).toFixed(1) : '0'

          return (
            <div key={node.node} className="contents">
              <div className="bg-[var(--joy-palette-background-surface)] px-3 py-2 font-medium">{node.node}</div>
              <div className="bg-[var(--joy-palette-background-surface)] px-3 py-2">
                <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                  node.status === 'online'
                    ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                    : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
                }`}>
                  {node.status}
                </span>
              </div>
              <div className="bg-[var(--joy-palette-background-surface)] px-3 py-2 text-right font-mono text-sm">
                {cpuPercent}% <span className="text-neutral-400">({node.maxcpu}c)</span>
              </div>
              <div className="bg-[var(--joy-palette-background-surface)] px-3 py-2 text-right font-mono text-sm">
                {memPercent}% <span className="text-neutral-400">({formatBytes(node.maxmem, false, false)})</span>
              </div>
              <div className="bg-[var(--joy-palette-background-surface)] px-3 py-2 text-right font-mono text-sm">
                {diskPercent}%
              </div>
              <div className="bg-[var(--joy-palette-background-surface)] px-3 py-2 text-right font-mono text-sm">
                {node.status === 'online' ? formatUptime(node.uptime) : '-'}
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

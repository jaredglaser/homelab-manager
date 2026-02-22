import { Sheet, Typography } from '@mui/joy'
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
  const sortedNodes = [...nodes].sort((a, b) => a.node.localeCompare(b.node))

  return (
    <div className="mb-6">
      <Typography level="title-lg" className="mb-3">Nodes</Typography>
      <Sheet variant="outlined" className="rounded-sm overflow-hidden">
        <div className="grid"
          style={{ gridTemplateColumns: '1.5fr 0.8fr 1fr 1.2fr 0.8fr 0.8fr' }}
        >
          {/* Header */}
          <div className="px-3 py-2 font-semibold text-sm border-b border-neutral-200 dark:border-neutral-700">Node</div>
          <div className="px-3 py-2 font-semibold text-sm border-b border-neutral-200 dark:border-neutral-700">Status</div>
          <div className="px-3 py-2 font-semibold text-sm border-b border-neutral-200 dark:border-neutral-700 text-right">CPU</div>
          <div className="px-3 py-2 font-semibold text-sm border-b border-neutral-200 dark:border-neutral-700 text-right">Memory</div>
          <div className="px-3 py-2 font-semibold text-sm border-b border-neutral-200 dark:border-neutral-700 text-right">Disk</div>
          <div className="px-3 py-2 font-semibold text-sm border-b border-neutral-200 dark:border-neutral-700 text-right">Uptime</div>

          {/* Rows */}
          {sortedNodes.map((node) => {
            const cpuPercent = (node.cpu * 100).toFixed(1)
            const memPercent = node.maxmem > 0 ? ((node.mem / node.maxmem) * 100).toFixed(1) : '0'
            const diskPercent = node.maxdisk > 0 ? ((node.disk / node.maxdisk) * 100).toFixed(1) : '0'

            return (
              <div key={node.node} className="contents">
                <div className="px-3 py-2 font-medium border-b border-neutral-200 dark:border-neutral-700">{node.node}</div>
                <div className="px-3 py-2 border-b border-neutral-200 dark:border-neutral-700">
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                    node.status === 'online'
                      ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                      : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
                  }`}>
                    {node.status}
                  </span>
                </div>
                <div className="px-3 py-2 text-right font-mono text-sm border-b border-neutral-200 dark:border-neutral-700">
                  {cpuPercent}% <span className="text-neutral-400">({node.maxcpu}c)</span>
                </div>
                <div className="px-3 py-2 text-right font-mono text-sm border-b border-neutral-200 dark:border-neutral-700">
                  {memPercent}% <span className="text-neutral-400">({formatBytes(node.maxmem, false, false)})</span>
                </div>
                <div className="px-3 py-2 text-right font-mono text-sm border-b border-neutral-200 dark:border-neutral-700">
                  {diskPercent}%
                </div>
                <div className="px-3 py-2 text-right font-mono text-sm border-b border-neutral-200 dark:border-neutral-700">
                  {node.status === 'online' ? formatUptime(node.uptime) : '-'}
                </div>
              </div>
            )
          })}
        </div>
      </Sheet>
    </div>
  )
}

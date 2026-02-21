import { Card, Typography } from '@mui/joy'
import type { ProxmoxStorage } from '@/types/proxmox'
import { formatBytes } from '@/formatters/metrics'

interface StorageTableProps {
  storages: (ProxmoxStorage & { node: string })[]
}

export default function StorageTable({ storages }: StorageTableProps) {
  // Deduplicate shared storage (same name, shared=1) - show once with "shared" label
  const seen = new Map<string, (ProxmoxStorage & { node: string }) & { nodeList: string[] }>()

  for (const s of storages) {
    const key = s.shared ? s.storage : `${s.node}/${s.storage}`
    const existing = seen.get(key)
    if (existing) {
      if (!existing.nodeList.includes(s.node)) {
        existing.nodeList.push(s.node)
      }
    } else {
      seen.set(key, { ...s, nodeList: [s.node] })
    }
  }

  const dedupedStorages = Array.from(seen.values())

  if (dedupedStorages.length === 0) {
    return (
      <Card variant="outlined" className="mb-6">
        <Typography level="title-lg" className="mb-3">Storage</Typography>
        <Typography level="body-sm" className="text-neutral-500">No storage found.</Typography>
      </Card>
    )
  }

  return (
    <Card variant="outlined" className="mb-6">
      <Typography level="title-lg" className="mb-3">
        Storage ({dedupedStorages.length})
      </Typography>
      <div
        className="grid gap-px bg-neutral-200 dark:bg-neutral-700 rounded-lg overflow-hidden"
        style={{ gridTemplateColumns: 'minmax(120px, 1fr) 100px 100px 80px 100px 100px 120px' }}
      >
        {/* Header */}
        <div className="bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Name</div>
        <div className="bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Node</div>
        <div className="bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Type</div>
        <div className="bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Status</div>
        <div className="bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500 text-right">Used</div>
        <div className="bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500 text-right">Available</div>
        <div className="bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500 text-right">Usage</div>

        {/* Rows */}
        {dedupedStorages.map((s) => {
          const usagePercent = (s.used_fraction * 100).toFixed(1)

          return (
            <div key={`${s.nodeList.join(',')}-${s.storage}`} className="contents">
              <div className="bg-[var(--joy-palette-background-surface)] px-3 py-2 font-medium">{s.storage}</div>
              <div className="bg-[var(--joy-palette-background-surface)] px-3 py-2 text-sm text-neutral-500">
                {s.shared ? 'shared' : s.nodeList[0]}
              </div>
              <div className="bg-[var(--joy-palette-background-surface)] px-3 py-2 text-sm">{s.type}</div>
              <div className="bg-[var(--joy-palette-background-surface)] px-3 py-2">
                <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                  s.active
                    ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                    : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
                }`}>
                  {s.active ? 'active' : 'inactive'}
                </span>
              </div>
              <div className="bg-[var(--joy-palette-background-surface)] px-3 py-2 text-right font-mono text-sm">
                {s.total > 0 ? formatBytes(s.used, false, false) : '-'}
              </div>
              <div className="bg-[var(--joy-palette-background-surface)] px-3 py-2 text-right font-mono text-sm">
                {s.total > 0 ? formatBytes(s.avail, false, false) : '-'}
              </div>
              <div className="bg-[var(--joy-palette-background-surface)] px-3 py-2 text-right">
                {s.total > 0 ? (
                  <div className="flex items-center gap-2 justify-end">
                    <div className="w-16 h-2 bg-neutral-200 dark:bg-neutral-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          s.used_fraction > 0.9
                            ? 'bg-red-500'
                            : s.used_fraction > 0.7
                              ? 'bg-yellow-500'
                              : 'bg-green-500'
                        }`}
                        style={{ width: `${Math.min(s.used_fraction * 100, 100)}%` }}
                      />
                    </div>
                    <span className="font-mono text-sm">{usagePercent}%</span>
                  </div>
                ) : '-'}
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

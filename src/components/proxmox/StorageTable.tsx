import { Sheet, Typography } from '@mui/joy'
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

  const dedupedStorages = Array.from(seen.values()).sort((a, b) =>
    a.storage.localeCompare(b.storage)
  )

  if (dedupedStorages.length === 0) {
    return (
      <div className="mb-6">
        <Typography level="title-lg" className="mb-3">Storage</Typography>
        <Typography level="body-sm" className="text-neutral-500">No storage found.</Typography>
      </div>
    )
  }

  return (
    <div className="mb-6">
      <Typography level="title-lg" className="mb-3">
        Storage ({dedupedStorages.length})
      </Typography>
      <Sheet variant="outlined" className="rounded-sm overflow-hidden">
        <div
          className="grid"
          style={{ gridTemplateColumns: '1.5fr 0.8fr 0.8fr 0.6fr 1fr 1fr 1.2fr' }}
        >
          {/* Header */}
          <div className="px-3 py-2 font-semibold text-sm border-b border-neutral-200 dark:border-neutral-700">Name</div>
          <div className="px-3 py-2 font-semibold text-sm border-b border-neutral-200 dark:border-neutral-700">Node</div>
          <div className="px-3 py-2 font-semibold text-sm border-b border-neutral-200 dark:border-neutral-700">Type</div>
          <div className="px-3 py-2 font-semibold text-sm border-b border-neutral-200 dark:border-neutral-700">Status</div>
          <div className="px-3 py-2 font-semibold text-sm border-b border-neutral-200 dark:border-neutral-700 text-right">Used</div>
          <div className="px-3 py-2 font-semibold text-sm border-b border-neutral-200 dark:border-neutral-700 text-right">Available</div>
          <div className="px-3 py-2 font-semibold text-sm border-b border-neutral-200 dark:border-neutral-700 text-right">Usage</div>

          {/* Rows */}
          {dedupedStorages.map((s) => {
            const usagePercent = (s.used_fraction * 100).toFixed(1)

            return (
              <div key={`${s.nodeList.join(',')}-${s.storage}`} className="contents">
                <div className="px-3 py-2 font-medium border-b border-neutral-200 dark:border-neutral-700">{s.storage}</div>
                <div className="px-3 py-2 text-sm text-neutral-500 border-b border-neutral-200 dark:border-neutral-700">
                  {s.shared ? 'shared' : s.nodeList[0]}
                </div>
                <div className="px-3 py-2 text-sm border-b border-neutral-200 dark:border-neutral-700">{s.type}</div>
                <div className="px-3 py-2 border-b border-neutral-200 dark:border-neutral-700">
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                    s.active
                      ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                      : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
                  }`}>
                    {s.active ? 'active' : 'inactive'}
                  </span>
                </div>
                <div className="px-3 py-2 text-right font-mono text-sm border-b border-neutral-200 dark:border-neutral-700">
                  {s.total > 0 ? formatBytes(s.used, false, false) : '-'}
                </div>
                <div className="px-3 py-2 text-right font-mono text-sm border-b border-neutral-200 dark:border-neutral-700">
                  {s.total > 0 ? formatBytes(s.avail, false, false) : '-'}
                </div>
                <div className="px-3 py-2 text-right border-b border-neutral-200 dark:border-neutral-700">
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
      </Sheet>
    </div>
  )
}

import { useMemo } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Paper, Typography } from '@mui/material'
import { Server, Layers } from 'lucide-react'
import { useStacksContext } from '@/components/stacks/stacks-context'

export const Route = createFileRoute('/stacks/')({
  ssr: false,
  component: StacksOverview,
})

function StacksOverview() {
  const { stacks, statusMap, isLoading } = useStacksContext()

  const hostSummaries = useMemo(() => {
    const byHost = new Map<string, { total: number; running: number }>();
    for (const stack of stacks) {
      const entry = byHost.get(stack.host) ?? { total: 0, running: 0 };
      entry.total++;
      const statusKey = `${stack.host}/${stack.name}`;
      const status = statusMap.get(statusKey);
      if (status && status.containers.some(c => c.status === 'running')) {
        entry.running++;
      }
      byHost.set(stack.host, entry);
    }
    return Array.from(byHost.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([host, counts]) => ({ host, ...counts }));
  }, [stacks, statusMap])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 opacity-50">
        <Typography variant="body2">Loading stacks...</Typography>
      </div>
    )
  }

  if (stacks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <Layers size={40} className="opacity-20" />
        <Typography variant="body1" className="opacity-50">
          No stacks yet. Create one to get started.
        </Typography>
      </div>
    )
  }

  return (
    <div className="max-w-lg">
      <Typography variant="h6" className="mb-4">Stacks Overview</Typography>
      <div className="flex flex-col gap-3">
        {hostSummaries.map(({ host, total, running }) => (
          <Paper
            key={host}
            variant="outlined"
            className="flex items-center gap-3 px-4 py-3"
          >
            <Server size={18} className="opacity-50" />
            <div className="flex-1">
              <Typography variant="body2" className="font-medium">{host}</Typography>
              <Typography variant="caption" className="opacity-60">
                {total} {total === 1 ? 'stack' : 'stacks'} &middot; {running} running
              </Typography>
            </div>
          </Paper>
        ))}
      </div>
      <Typography variant="body2" className="mt-6 opacity-40">
        Select a stack from the sidebar to edit its compose file and manage deployments.
      </Typography>
    </div>
  )
}

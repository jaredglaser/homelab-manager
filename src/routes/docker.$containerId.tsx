import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import AppShell from '@/components/AppShell'
import ContainerHistoryPage from '@/components/docker/ContainerHistoryPage'

const searchSchema = z.object({
  host: z.string().optional(),
  metrics: z.string().optional().default('cpu,memory'),
  from: z.coerce.number().pipe(z.number().finite()).optional(),
  to: z.coerce.number().pipe(z.number().finite()).optional(),
})

export const Route = createFileRoute('/docker/$containerId')({
  ssr: false,
  validateSearch: (search) => searchSchema.parse(search),
  component: ContainerDetailRoute,
})

function ContainerDetailRoute() {
  const { containerId } = Route.useParams()
  const search = Route.useSearch()

  return (
    <AppShell>
      <ContainerHistoryPage
        containerId={containerId}
        host={search.host}
        initialMetrics={search.metrics}
        initialFrom={search.from}
        initialTo={search.to}
      />
    </AppShell>
  )
}

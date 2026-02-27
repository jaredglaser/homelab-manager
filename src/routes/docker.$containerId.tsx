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

/**
 * Render the container detail route UI, composing AppShell and ContainerHistoryPage
 * with values derived from the current route parameters and validated search query.
 *
 * The rendered ContainerHistoryPage receives the route `containerId` and the search
 * values `host`, `metrics`, `from`, and `to` as its initial props.
 *
 * @returns The JSX element for the container detail route.
 */
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

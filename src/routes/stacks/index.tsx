import { createFileRoute } from '@tanstack/react-router'
import StacksOverview from '@/components/stacks/StacksOverview'

export const Route = createFileRoute('/stacks/')({
  ssr: false,
  component: StacksOverview,
})

import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/docker/$containerId')({
  beforeLoad: () => {
    throw redirect({ to: '/docker' })
  },
})

import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/docker/$containerId')({
  ssr: false,
  beforeLoad: () => {
    throw redirect({ to: '/docker' })
  },
})

import { createRouter } from '@tanstack/react-router'

import { routeTree } from './routeTree.gen'
import { NAV_ORDER } from '@/components/Header'

export const getRouter = () => {
  const router = createRouter({
    routeTree,
    context: {},
    basepath: import.meta.env.BASE_URL?.replace(/\/$/, '') || '/',
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    defaultViewTransition: {
      types: ({ fromLocation, toLocation }) => {
        const fromIndex = NAV_ORDER[fromLocation?.pathname ?? ''] ?? -1
        const toIndex = NAV_ORDER[toLocation.pathname] ?? -1
        if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return ['fade']
        return fromIndex < toIndex ? ['slide-forward'] : ['slide-back']
      },
    },
  })

  return router
}

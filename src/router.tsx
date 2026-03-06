import { createRouter } from '@tanstack/react-router'

import { routeTree } from './routeTree.gen'

const NAV_ORDER: Record<string, number> = {
  '/docker': 0,
  '/zfs': 1,
  '/proxmox': 2,
  '/settings': 3,
}

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

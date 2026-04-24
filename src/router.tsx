import { createRouter } from '@tanstack/react-router'

import { routeTree } from './routeTree.gen'

export const getRouter = () => {
  const router = createRouter({
    routeTree,
    context: {},
    basepath: import.meta.env.BASE_URL?.replace(/\/$/, '') || '/',
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    defaultViewTransition: { types: () => ['fade'] },
  })

  return router
}

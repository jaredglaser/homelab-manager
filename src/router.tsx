import { createRouter } from '@tanstack/react-router'

import { routeTree } from './routeTree.gen'

export const getRouter = () => {
  const router = createRouter({
    routeTree,
    context: {},
    basepath: import.meta.env.BASE_URL?.replace(/\/$/, '') || '/',
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    // View transitions are disabled: navigating to a data-heavy tab (Docker,
    // ZFS) flashed white in the content area, in both light and dark mode. The
    // View Transitions API rasterizes the old and new DOM into snapshot images,
    // and that capture forces a synchronous paint of the whole page-content
    // element including the DataTable's normally-skipped `content-visibility:
    // auto` rows. That capture frame is what flashes; it lives in the compositor
    // snapshot pipeline, not in any element's computed style (every DOM-level
    // probe and mid-fade screenshot read dark). Disabling the API removes it.
    // The inert leftovers stay ready for re-enabling: the page-content fade CSS
    // in App.css and the `[view-transition-name:page-content]` class in
    // AppShell.
    // TODO: re-enable once the snapshot flash is fixed (likely by not giving the
    // content-visibility DataTable its own view-transition snapshot, e.g. fade
    // via plain CSS on route change instead of the View Transitions API).
    // defaultViewTransition: { types: () => ['fade'] },
  })

  return router
}

/**
 * Start the MSW service worker. Resolves once the worker is active and
 * controlling the page, so callers can gate the React tree on this promise and
 * guarantee the first request (auth session, preloads, SSE) is intercepted.
 *
 * The worker module is imported lazily so MSW and the mock handlers stay out of
 * the production bundle, which never calls this.
 */
export async function startMockServiceWorker(): Promise<void> {
  const { worker } = await import('@/lib/mock/browser');
  const base = import.meta.env.BASE_URL || '/';

  // The worker tees every mocked response and ships one branch to the page for
  // the life-cycle events; nothing reads it, and leaving it undrained
  // backpressures an SSE stream's source for the life of the tab.
  worker.events.on('response:mocked', ({ response }) => {
    void response.body?.cancel().catch(() => {});
  });

  await worker.start({
    serviceWorker: {
      // Respect the deploy base path (e.g. GitHub Pages) so the worker script
      // resolves under sub-path hosting, not just at the origin root.
      url: `${base.replace(/\/$/, '')}/mockServiceWorker.js`,
    },
    // The app also talks to static assets, icons, and HMR endpoints that have no
    // handler; let those reach the real (dev) server untouched.
    onUnhandledRequest: 'bypass',
    quiet: true,
  });

  // On a cold load the worker registers but does not control this page until it
  // claims clients, and `worker.start()` can resolve a tick before that. Without
  // waiting, the first fetch (the auth session check) slips through to the real
  // backend and the app bounces to /login. Wait for control so callers can assume
  // every subsequent request is intercepted.
  if (
    typeof navigator !== 'undefined' &&
    navigator.serviceWorker &&
    !navigator.serviceWorker.controller
  ) {
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      navigator.serviceWorker.addEventListener('controllerchange', done, { once: true });
      // Safety net: never hang the app if the event is missed.
      setTimeout(done, 3000);
    });

    if (!navigator.serviceWorker.controller) {
      const message =
        '[msw] service worker never took control; requests reach the real backend and the app redirects to /login';
      console.error(message);
      if (import.meta.env.VITE_ENABLE_MSW === 'true') {
        throw new Error(message);
      }
      // A demo build has no backend to degrade to, so retry the load once per tab.
      if (import.meta.env.VITE_DEMO_MODE === 'true' && claimTakeoverReload()) {
        window.location.reload();
      }
    }
  }
}

const TAKEOVER_RELOAD_KEY = 'msw:takeover-reload';

function claimTakeoverReload(): boolean {
  try {
    if (sessionStorage.getItem(TAKEOVER_RELOAD_KEY)) return false;
    sessionStorage.setItem(TAKEOVER_RELOAD_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

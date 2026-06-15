import { HeadContent, Outlet, Scripts, createRootRoute, useRouterState } from '@tanstack/react-router'
import { lazy } from 'react'
import AppShell from '@/components/AppShell'
import { ErrorBoundary } from '@/components/shared/ErrorBoundary'
import { IS_MOCK_ENABLED } from '@/lib/constants/mock'

import '../App.css'
import '@fontsource/inter/index.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'

// Skip the devtools when MSW is on (demo / e2e): they are dev-only debug UI and
// their lazy chunk races Vite's mock-triggered dep re-optimization, surfacing as
// a spurious "failed to load module" error in the app under test.
const SHOW_DEVTOOLS = import.meta.env.DEV && !IS_MOCK_ENABLED

const TanStackDevtools = SHOW_DEVTOOLS
  ? lazy(() =>
      import('@tanstack/react-devtools').then(mod => ({
        default: mod.TanStackDevtools,
      }))
    )
  : () => null

const TanStackRouterDevtoolsPanel = SHOW_DEVTOOLS
  ? lazy(() =>
      import('@tanstack/react-router-devtools').then(mod => ({
        default: mod.TanStackRouterDevtoolsPanel,
      }))
    )
  : () => null

export const Route = createRootRoute({
  ssr: false,
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'initial-scale=1, width=device-width',
      },
      {
        title: 'Homelab Manager',
      },
    ],
    links: [
      {
        rel: 'icon',
        href: `${import.meta.env.BASE_URL}favicon.ico`,
      },
    ],
  }),

  component: RootLayout,
  shellComponent: RootDocument,
})

function RootLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isAuthPage = pathname === '/login' || pathname === '/denied';

  if (isAuthPage) {
    return <Outlet />;
  }

  return (
    <AppShell>
      <ErrorBoundary name="root">
        <Outlet />
      </ErrorBoundary>
    </AppShell>
  );
}

function RootDocument({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // suppressHydrationWarning: the pre-paint script below sets data-color-scheme
    // on <html> before React hydrates the static shell (which has no such
    // attribute), so the attribute mismatch on this element is intentional.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Set the color scheme before first paint to avoid a light/dark flash.
            Mirrors the default and legacy-key logic in useColorMode. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var m=localStorage.getItem('color-scheme')||localStorage.getItem('mui-mode');if(m!=='light'&&m!=='dark')m='dark';document.documentElement.setAttribute('data-color-scheme',m);}catch(e){document.documentElement.setAttribute('data-color-scheme','dark');}})();",
          }}
        />
        <HeadContent />
      </head>
      <body>
        {children}
        {SHOW_DEVTOOLS && (
          <TanStackDevtools
            config={{
              position: 'bottom-right',
            }}
            plugins={[
              {
                name: 'Tanstack Router',
                render: <TanStackRouterDevtoolsPanel />,
              },
            ]}
          />
        )}
        <Scripts />
      </body>
    </html>
  )
}

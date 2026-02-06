import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { lazy } from 'react'

import appCss from '../styles.css?url'
import '../App.css'
import '@fontsource/inter/index.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'

const TanStackDevtools = import.meta.env.DEV
  ? lazy(() =>
      import('@tanstack/react-devtools').then(mod => ({
        default: mod.TanStackDevtools,
      }))
    )
  : () => null

const TanStackRouterDevtoolsPanel = import.meta.env.DEV
  ? lazy(() =>
      import('@tanstack/react-router-devtools').then(mod => ({
        default: mod.TanStackRouterDevtoolsPanel,
      }))
    )
  : () => null

export const Route = createRootRoute({
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
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),

  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        {import.meta.env.DEV && (
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

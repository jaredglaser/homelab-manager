import { useMemo, useState } from 'react'
import Tabs from '@mui/material/Tabs'
import Tab from '@mui/material/Tab'
import Popper from '@mui/material/Popper'
import Paper from '@mui/material/Paper'
import { Link } from '@tanstack/react-router'
import { ChevronDown } from 'lucide-react'
import ModeToggle from '@/components/ModeToggle'
import { IS_DEMO_MODE } from '@/lib/constants/demo'
import type { AuthUser } from '@/lib/auth/types'
import {
  NAV_ITEMS,
  type RouteKey,
  type MenuRouteKey,
  handlePrefetch,
} from '@/components/header/nav-config'
import { useCurrentTab, useMenuController } from '@/components/header/useMenuController'
import { AccountMenu, MenuContentFor, NavMenuCloseContext } from '@/components/header/menus'
import { DemoBanner } from '@/components/header/DemoBanner'

// Brand SVGs (Docker, Proxmox) lack the small transparent padding that lucide icons
// bake into their viewBoxes, so they sit too close to the tab label. This set marks
// which routes need extra right margin in tab contexts without affecting dropdown
// contexts that already use flex gap-* for spacing.
const SPACED_ICON_ROUTES = new Set<RouteKey>(['/docker', '/proxmox'])

export default function Header({ user }: Readonly<{ user?: AuthUser | null }>) {
  const currentTab = useCurrentTab()
  const controller = useMenuController()
  const [anchors, setAnchors] = useState<Partial<Record<MenuRouteKey, HTMLElement>>>({})

  // Stable callback refs keyed by route, so each Tab keeps the same setter
  // across renders. The null (unmount) case is ignored because these Tab
  // elements are persistent; anchors only need to be set once on mount.
  const refSetters = useMemo(() => {
    const setters: Partial<Record<MenuRouteKey, (el: HTMLElement | null) => void>> = {}
    for (const item of NAV_ITEMS) {
      if (!item.hasMenu) continue
      setters[item.to] = (el) => {
        if (!el) return
        setAnchors((prev) => (prev[item.to] === el ? prev : { ...prev, [item.to]: el }))
      }
    }
    return setters
  }, [])

  return (
    <header className="sticky top-0 z-50 px-4 pt-3 pb-2 pointer-events-none">
      <nav
        aria-label="Main navigation"
        className="flex items-center rounded-2xl px-3 py-1 pointer-events-auto backdrop-blur-xl bg-(--mui-palette-background-paper)/75 border border-(--mui-palette-divider)/30 shadow-[0_8px_32px_var(--mui-palette-common-black)]/10"
      >
        <Tabs value={currentTab ?? false} aria-label="Main navigation" className="min-h-0!">
          {NAV_ITEMS.map((item) => {
            const { Icon } = item
            return (
              <Tab
                key={item.to}
                value={item.to}
                ref={refSetters[item.to as MenuRouteKey]}
                label={
                  <span className="inline-flex items-center gap-1">
                    {item.label}
                    {item.hasMenu && <ChevronDown size={14} className="opacity-60" />}
                  </span>
                }
                icon={
                  SPACED_ICON_ROUTES.has(item.to)
                    ? <span className="inline-flex mr-1"><Icon size={18} /></span>
                    : <Icon size={18} />
                }
                iconPosition="start"
                component={Link}
                to={item.to}
                disableRipple
                aria-haspopup={item.hasMenu ? 'menu' : undefined}
                aria-expanded={item.hasMenu ? controller.openId === item.to : undefined}
                aria-controls={item.hasMenu ? `nav-menu-${item.to.slice(1)}` : undefined}
                onMouseEnter={() => {
                  handlePrefetch(item.to)
                  if (item.hasMenu) controller.requestOpen(item.to)
                }}
                onMouseLeave={() => {
                  if (item.hasMenu) controller.requestClose()
                }}
                onFocus={() => {
                  handlePrefetch(item.to)
                  if (item.hasMenu) controller.requestOpen(item.to)
                }}
                onBlur={() => {
                  if (item.hasMenu) controller.requestClose()
                }}
                onKeyDown={(e: React.KeyboardEvent) => {
                  if (e.key === 'Escape' && item.hasMenu) controller.closeNow()
                }}
                className="min-h-0! py-2!"
              />
            )
          })}
        </Tabs>

        <div className="ml-auto pl-3 border-l border-(--mui-palette-divider)/30 flex items-center gap-1">
          {!IS_DEMO_MODE && user && <AccountMenu />}
          <ModeToggle />
        </div>
      </nav>

      {NAV_ITEMS.filter((i) => i.hasMenu).map((item) => {
        const anchor = anchors[item.to]
        return (
          <Popper
            key={item.to}
            open={controller.openId === item.to && Boolean(anchor)}
            anchorEl={anchor ?? null}
            placement="bottom-start"
            modifiers={[{ name: 'offset', options: { offset: [0, 8] } }]}
            className="z-50!"
          >
            <Paper
              elevation={4}
              className="rounded-xl! backdrop-blur-xl! bg-(--mui-palette-background-paper)/95! border border-(--mui-palette-divider)/30 overflow-hidden min-w-56 pointer-events-auto"
              onMouseEnter={() => controller.requestOpen(item.to)}
              onMouseLeave={controller.requestClose}
              onFocus={() => controller.requestOpen(item.to)}
              onBlur={() => controller.requestClose()}
              onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key === 'Escape') controller.closeNow()
              }}
            >
              <div id={`nav-menu-${item.to.slice(1)}`} role="menu">
                <NavMenuCloseContext value={controller.closeNow}>
                  <MenuContentFor to={item.to} />
                </NavMenuCloseContext>
              </div>
            </Paper>
          </Popper>
        )
      })}

      {IS_DEMO_MODE && <DemoBanner />}
    </header>
  )
}

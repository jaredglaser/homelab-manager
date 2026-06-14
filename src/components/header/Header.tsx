import { useMemo, useState } from 'react'
import { Popover } from '@base-ui/react/popover'
import { Link } from '@tanstack/react-router'
import { ChevronDown } from 'lucide-react'
import ModeToggle from '@/components/ModeToggle'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
        className="flex items-center rounded-2xl px-3 py-1 pointer-events-auto backdrop-blur-xl bg-card/75 border border-border/30 shadow-[0_8px_32px_rgba(0,0,0,0.1)]"
      >
        <Tabs value={currentTab ?? null}>
          <TabsList aria-label="Main navigation">
            {NAV_ITEMS.map((item) => {
              const { Icon } = item
              return (
                <TabsTrigger
                  key={item.to}
                  value={item.to}
                  ref={refSetters[item.to as MenuRouteKey]}
                  nativeButton={false}
                  render={<Link to={item.to} />}
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
                  className="py-2 uppercase"
                >
                  {SPACED_ICON_ROUTES.has(item.to)
                    ? <span className="inline-flex mr-1"><Icon size={18} /></span>
                    : <Icon size={18} />}
                  <span className="inline-flex items-center gap-1 ml-1.5">
                    {item.label}
                    {item.hasMenu && <ChevronDown size={14} className="opacity-60" />}
                  </span>
                </TabsTrigger>
              )
            })}
          </TabsList>
        </Tabs>

        <div className="ml-auto pl-3 border-l border-border/30 flex items-center gap-1">
          {!IS_DEMO_MODE && user && <AccountMenu />}
          <ModeToggle />
        </div>
      </nav>

      {NAV_ITEMS.filter((i) => i.hasMenu).map((item) => {
        const anchor = anchors[item.to]
        return (
          <Popover.Root
            key={item.to}
            open={controller.openId === item.to && Boolean(anchor)}
            modal={false}
          >
            <Popover.Portal>
              <Popover.Positioner
                anchor={anchor ?? null}
                side="bottom"
                align="start"
                sideOffset={8}
                className="z-50"
              >
                <Popover.Popup
                  initialFocus={false}
                  className="rounded-xl backdrop-blur-xl bg-card/95 border border-border/30 shadow-lg overflow-hidden min-w-56 pointer-events-auto outline-none"
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
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        )
      })}

      {IS_DEMO_MODE && <DemoBanner />}
    </header>
  )
}

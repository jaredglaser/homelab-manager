import { useEffect, useState } from 'react'
import { Link, useLocation } from '@tanstack/react-router'
import { ChevronDown, Menu } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { NAV_ITEMS, handlePrefetch, menuRouteFor } from '@/components/header/nav-config'
import type { MenuRouteKey, NavItem } from '@/components/header/nav-config'
import { useCurrentTab } from '@/components/header/useMenuController'
import {
  MENU_ITEM_CLASSES,
  MenuContentFor,
  NavMenuCloseContext,
  useMenuRoutes,
} from '@/components/header/menus'

const NAV_LINK_CLASSES =
  'flex flex-1 items-center gap-3 min-h-12 px-4 text-sm font-medium uppercase ' +
  'tracking-[0.02857em] no-underline text-inherit'

function MobileNavItem({
  item,
  menuRoute,
  isCurrent,
  onNavigate,
  onExpand,
}: Readonly<{
  item: NavItem
  menuRoute: MenuRouteKey | null
  isCurrent: boolean
  onNavigate: () => void
  onExpand: () => void
}>) {
  const [expanded, setExpanded] = useState(isCurrent && menuRoute !== null)
  const { Icon } = item

  const toggle = () => {
    setExpanded((prev) => {
      if (!prev) onExpand()
      return !prev
    })
  }

  return (
    <div className="border-b border-border/30 last:border-b-0">
      <div className={`flex items-center ${isCurrent ? 'bg-accent text-primary' : ''}`}>
        {menuRoute ? (
          <button
            type="button"
            className={`${NAV_LINK_CLASSES} justify-between pr-3 cursor-pointer`}
            aria-expanded={expanded}
            aria-current={isCurrent ? 'page' : undefined}
            onClick={toggle}
          >
            <span className="flex items-center gap-3">
              <Icon size={20} />
              <span>{item.label}</span>
            </span>
            <ChevronDown
              size={18}
              className={`transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`}
            />
          </button>
        ) : (
          <Link
            to={item.to}
            className={NAV_LINK_CLASSES}
            onClick={onNavigate}
            aria-current={isCurrent ? 'page' : undefined}
          >
            <Icon size={20} />
            <span>{item.label}</span>
          </Link>
        )}
      </div>
      {menuRoute && (
        <Collapsible open={expanded}>
          <CollapsibleContent>
            <div className="bg-level1 pl-4" role="menu">
              <NavMenuCloseContext value={onNavigate}>
                {item.hasMenu && item.selfEntryLabel && (
                  <Link
                    to={item.to}
                    className={MENU_ITEM_CLASSES}
                    onClick={onNavigate}
                    role="menuitem"
                  >
                    <Icon size={14} />
                    <span>{item.selfEntryLabel}</span>
                  </Link>
                )}
                <MenuContentFor to={menuRoute} />
              </NavMenuCloseContext>
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}

/**
 * Header navigation below the `md` breakpoint. The desktop tab bar opens its
 * submenus on hover, which a touch device can never trigger, so the drawer
 * turns each one into a tap-expandable section instead.
 */
export default function MobileNav() {
  const [open, setOpen] = useState(false)
  const currentTab = useCurrentTab()
  const menuRoutes = useMenuRoutes()
  const pathname = useLocation({ select: (l) => l.pathname })

  useEffect(() => {
    setOpen(false)
  }, [pathname])

  const currentLabel = NAV_ITEMS.find((item) => item.to === currentTab)?.label

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="size-11 text-foreground"
        aria-label="Open navigation menu"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Menu size={22} />
      </Button>
      <span
        className={`ml-1 truncate text-sm font-medium uppercase tracking-[0.02857em] ${
          currentLabel ? 'text-primary' : 'text-muted-foreground'
        }`}
      >
        {currentLabel ?? 'Homelab Manager'}
      </span>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" aria-label="Main navigation">
          <SheetHeader>
            <SheetTitle>Homelab Manager</SheetTitle>
          </SheetHeader>
          <SheetBody>
            <nav aria-label="Main navigation">
              {NAV_ITEMS.map((item) => (
                <MobileNavItem
                  key={item.to}
                  item={item}
                  menuRoute={menuRouteFor(item, menuRoutes)}
                  isCurrent={currentTab === item.to}
                  onNavigate={() => {
                    handlePrefetch(item.to)
                    setOpen(false)
                  }}
                  onExpand={() => handlePrefetch(item.to)}
                />
              ))}
            </nav>
          </SheetBody>
        </SheetContent>
      </Sheet>
    </>
  )
}

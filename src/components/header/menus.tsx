import { createContext, useContext, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { LogOut, Server, CircleUser } from 'lucide-react'
import { Popover } from '@base-ui/react/popover'
import { Button } from '@/components/ui/button'
import { STACKS_QUERY_KEY } from '@/lib/constants/stacks-keys'
import { listManagedHostNames, listStacks } from '@/data/stacks/functions'
import { getIconUrl } from '@/lib/utils/icon-resolver'
import { SETTINGS_SECTIONS } from '@/components/header/nav-config'
import type { MenuRouteKey } from '@/components/header/nav-config'

export const NavMenuCloseContext = createContext<() => void>(() => {})

const MENU_ITEM_CLASSES =
  'flex items-center gap-2 px-3 py-2 text-sm no-underline text-inherit ' +
  'hover:bg-accent transition-colors'

export function SettingsMenuContent() {
  const close = useContext(NavMenuCloseContext)
  return (
    <div role="none">
      {SETTINGS_SECTIONS.map((section) => {
        const { Icon } = section
        return (
          <Link
            key={section.id}
            to="/settings"
            hash={section.id}
            className={MENU_ITEM_CLASSES}
            onClick={close}
            role="menuitem"
          >
            <Icon size={14} />
            <span>{section.label}</span>
          </Link>
        )
      })}
    </div>
  )
}

export function StacksMenuContent() {
  const close = useContext(NavMenuCloseContext)
  const { data: stacks, isLoading, isError } = useQuery({
    queryKey: STACKS_QUERY_KEY,
    queryFn: () => listStacks(),
    staleTime: 30_000,
  })

  if (isLoading) {
    return <div className="px-3 py-2 text-sm opacity-60">Loading…</div>
  }
  if (isError) {
    return <div className="px-3 py-2 text-sm text-destructive">Failed to load stacks</div>
  }
  if (!stacks?.length) {
    return <div className="px-3 py-2 text-sm opacity-60">No stacks</div>
  }

  const sorted = [...stacks].sort((a, b) => a.name.localeCompare(b.name))

  return (
    <div className="max-h-[60vh] overflow-y-auto themed-scrollbar" role="none">
      {sorted.map((stack) => {
        const iconUrl = stack.icon ? getIconUrl(stack.icon, '') : null
        return (
          <Link
            key={`${stack.host}/${stack.name}`}
            to="/stacks/$stackName"
            params={{ stackName: stack.name }}
            className={MENU_ITEM_CLASSES}
            onClick={close}
            role="menuitem"
          >
            {iconUrl ? (
              <img src={iconUrl} alt="" className="w-4 h-4 rounded-sm" />
            ) : (
              <span className="w-4 h-4 rounded-sm bg-foreground/12 flex items-center justify-center text-[10px] font-bold opacity-50">
                {(stack.name.charAt(0) || '?').toUpperCase()}
              </span>
            )}
            <span className="truncate flex-1">{stack.name}</span>
            <span className="text-[10px] opacity-50">{stack.host}</span>
          </Link>
        )
      })}
    </div>
  )
}

export function DockerHostsMenuContent() {
  const close = useContext(NavMenuCloseContext)
  const { data: hosts, isLoading, isError } = useQuery({
    queryKey: ['managed-host-names'],
    queryFn: () => listManagedHostNames(),
    staleTime: 60_000,
  })

  if (isLoading) {
    return <div className="px-3 py-2 text-sm opacity-60">Loading…</div>
  }
  if (isError) {
    return <div className="px-3 py-2 text-sm text-destructive">Failed to load hosts</div>
  }
  if (!hosts?.length) {
    return <div className="px-3 py-2 text-sm opacity-60">No hosts</div>
  }

  return (
    <div role="none">
      {hosts.map((host) => (
        <Link
          key={host}
          to="/docker"
          hash={`host-${host}`}
          className={MENU_ITEM_CLASSES}
          onClick={close}
          role="menuitem"
        >
          <Server size={14} />
          <span className="truncate">{host}</span>
        </Link>
      ))}
    </div>
  )
}

export function AccountMenu() {
  const [open, setOpen] = useState(false)

  return (
    <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
      <Popover.Trigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-foreground"
            aria-label="Account menu"
            aria-haspopup="menu"
          />
        }
      >
        <CircleUser size={20} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-50">
          <Popover.Popup className="rounded-xl backdrop-blur-xl bg-card/95 border border-border/30 shadow-lg overflow-hidden min-w-36 pointer-events-auto outline-none">
            <div role="menu">
              <a
                href="/api/auth/logout"
                className={MENU_ITEM_CLASSES}
                role="menuitem"
              >
                <LogOut size={14} />
                <span>Log out</span>
              </a>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

export function MenuContentFor({ to }: Readonly<{ to: MenuRouteKey }>) {
  if (to === '/settings') return <SettingsMenuContent />
  if (to === '/stacks') return <StacksMenuContent />
  if (to === '/docker') return <DockerHostsMenuContent />
  return null
}

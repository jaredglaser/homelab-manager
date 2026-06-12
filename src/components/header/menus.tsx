import { createContext, useContext, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { LogOut, Server, CircleUser } from 'lucide-react'
import IconButton from '@mui/material/IconButton'
import Popper from '@mui/material/Popper'
import Paper from '@mui/material/Paper'
import ClickAwayListener from '@mui/material/ClickAwayListener'
import { STACKS_QUERY_KEY } from '@/lib/constants/stacks-keys'
import { listManagedHostNames, listStacks } from '@/data/stacks/functions'
import { getIconUrl } from '@/lib/utils/icon-resolver'
import { SETTINGS_SECTIONS } from '@/components/header/nav-config'
import type { MenuRouteKey } from '@/components/header/nav-config'

export const NavMenuCloseContext = createContext<() => void>(() => {})

const MENU_ITEM_CLASSES =
  'flex items-center gap-2 px-3 py-2 text-sm no-underline text-inherit ' +
  'hover:bg-(--mui-palette-action-hover) transition-colors'

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
    return <div className="px-3 py-2 text-sm text-(--mui-palette-error-main)">Failed to load stacks</div>
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
              <span className="w-4 h-4 rounded-sm bg-(--mui-palette-action-disabledBackground) flex items-center justify-center text-[10px] font-bold opacity-50">
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
    return <div className="px-3 py-2 text-sm text-(--mui-palette-error-main)">Failed to load hosts</div>
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
  const anchorRef = useRef<HTMLButtonElement>(null)

  return (
    <>
      <IconButton
        ref={anchorRef}
        size="small"
        onClick={() => setOpen((prev) => !prev)}
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <CircleUser size={20} />
      </IconButton>
      <Popper
        open={open}
        anchorEl={anchorRef.current}
        placement="bottom-end"
        modifiers={[{ name: 'offset', options: { offset: [0, 8] } }]}
        className="z-50"
      >
        <ClickAwayListener onClickAway={() => setOpen(false)}>
          <Paper
            elevation={4}
            className="rounded-xl backdrop-blur-xl bg-(--mui-palette-background-paper)/95 border border-(--mui-palette-divider)/30 overflow-hidden min-w-36 pointer-events-auto"
          >
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
          </Paper>
        </ClickAwayListener>
      </Popper>
    </>
  )
}

export function MenuContentFor({ to }: Readonly<{ to: MenuRouteKey }>) {
  if (to === '/settings') return <SettingsMenuContent />
  if (to === '/stacks') return <StacksMenuContent />
  if (to === '/docker') return <DockerHostsMenuContent />
  return null
}

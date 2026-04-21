import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import Alert from '@mui/material/Alert'
import MuiLink from '@mui/material/Link'
import Tabs from '@mui/material/Tabs'
import Tab from '@mui/material/Tab'
import Popper from '@mui/material/Popper'
import Paper from '@mui/material/Paper'
import { Link, useLocation } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  Archive,
  ChevronDown,
  Code,
  HardDrive,
  Layers,
  Server,
  Settings as SettingsIcon,
  SlidersHorizontal,
} from 'lucide-react'
import ModeToggle from '@/components/ModeToggle'
import { MENU_CLOSE_DELAY_MS } from '@/lib/constants/ui-timing'
import { queryClient } from '@/components/AppShell'
import {
  DOCKER_PRELOAD_KEY, ZFS_PRELOAD_KEY, PROXMOX_PRELOAD_KEY,
  preloadDockerStats, preloadZFSStats, preloadProxmoxStats,
} from '@/lib/constants/preload-queries'
import { STACKS_QUERY_KEY } from '@/lib/constants/stacks-keys'
import { listManagedHostNames, listStacks } from '@/data/stacks/functions'
import { getIconUrl } from '@/lib/utils/icon-resolver'

interface IconProps {
  size?: number
}

function DockerIcon({ size = 18 }: Readonly<IconProps>) {
  return (
    <svg viewBox="-1 70 514 372" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false" className="mr-2">
      <path d="M501.4 212.3c-11.5-8-38-11-58.6-7-2.4-20-13.5-37.5-32.7-53l-11-8-7.7 11.5c-9.6 15-14.4 36-13 56 .5 7 2.9 19.5 10.1 30.5-6.7 4-20.7 9-38.9 9H2.3l-1 4c-3.4 20-3.4 82.5 36 130.5 29.8 36.5 74 55 132.1 55 125.9 0 219.1-60.5 262.8-170 17.3.5 54.3 0 73-37.5.5-1 1.4-3 4.8-10.5l1.9-4zM280 71.3h-52.8v50H280zm0 60h-52.8v50H280zm-62.5 0h-52.8v50h52.8zm-62.4 0h-52.8v50h52.8zm-62.5 60H39.8v50h52.8zm62.5 0h-52.8v50h52.8zm62.4 0h-52.8v50h52.8zm62.5 0h-52.8v50H280zm62.4 0h-52.8v50h52.8z" />
    </svg>
  )
}

function ProxmoxIcon({ size = 18 }: Readonly<IconProps>) {
  return (
    <svg viewBox="0 34 512 444" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false" className="mr-2">
      <path d="M137.9 34.1c-10.5 0-19.7 1.9-28.5 5.7-8.6 3.8-16.2 8.9-22.9 15.6l170 186.4L426.1 55.3c-6.7-6.7-14.3-11.8-23.4-15.6-8.3-3.8-18-5.7-28-5.7-10.5 0-20.5 2.2-29.4 6.2-9.2 4-16.7 10-23.7 17l-65.2 72.2-66-72.2c-6.7-7-14.3-12.9-23.7-17-8.3-4-18.3-6.1-28.8-6.1M256.4 270l-170 186.7c6.7 6.5 14.3 11.8 22.9 15.6 8.9 3.8 18.1 5.7 28 5.7 11 0 20.5-2.4 29.4-6.2 9.4-4.3 17.5-10 24.2-17l65.5-72.2 65.4 72.2c6.7 7 14.3 12.7 23.4 17 8.9 3.8 18.6 6.2 29.4 6.2 10 0 19.7-1.9 28-5.7 9.2-3.8 16.7-9.2 23.4-15.6z" />
      <path d="M56 90.1c-10.8.3-21.3 2.4-30.7 6.5-9.7 4-18 9.7-25.3 16.7L129.8 256 0 398.5c7.3 7.3 15.6 12.9 25.3 17.2 9.4 4.3 19.9 6.2 30.7 6.7 11.6-.5 22.4-2.4 32.3-7.3q15-6.9 25.8-18.6l128-140.5-127.9-140.3c-7.8-7.5-16.2-13.7-26.1-18.6-10-4.6-20.5-6.7-32.1-7m399.7 0c-11.6.3-21.8 2.4-31.8 7-10 4.8-18.6 11-26.1 18.6L270.4 256l127.4 140.6q11.25 11.7 26.1 18.6c10 4.8 20.2 6.7 31.8 7.3 11.6-.5 21.5-2.4 31-6.7 10.2-4.3 18-10 25.3-17.2L382.5 256 512 113.3c-7.3-7-15.1-12.7-25.3-16.7-9.4-4.1-19.4-6.2-31-6.5" />
    </svg>
  )
}

type RouteKey = '/docker' | '/stacks' | '/zfs' | '/proxmox' | '/settings'

interface NavItem {
  to: RouteKey
  label: string
  Icon: React.ComponentType<IconProps>
  hasMenu: boolean
}

const NAV_ITEMS: readonly NavItem[] = [
  { to: '/docker', label: 'Docker', Icon: DockerIcon, hasMenu: true },
  { to: '/stacks', label: 'Stacks', Icon: Layers, hasMenu: true },
  { to: '/zfs', label: 'ZFS', Icon: HardDrive, hasMenu: false },
  { to: '/proxmox', label: 'Proxmox', Icon: ProxmoxIcon, hasMenu: false },
  { to: '/settings', label: 'Settings', Icon: SettingsIcon, hasMenu: true },
]

export interface SettingsSectionDescriptor {
  id: string
  label: string
  Icon: React.ComponentType<IconProps>
}

export const SETTINGS_SECTIONS: readonly SettingsSectionDescriptor[] = [
  { id: 'general', label: 'General', Icon: SlidersHorizontal },
  { id: 'docker-dashboard', label: 'Docker Dashboard', Icon: DockerIcon },
  { id: 'zfs-dashboard', label: 'ZFS Dashboard', Icon: HardDrive },
  { id: 'data-retention', label: 'Data Retention', Icon: Archive },
  { id: 'managed-hosts', label: 'Managed Hosts', Icon: Server },
  { id: 'developer', label: 'Developer', Icon: Code },
]

const PREFETCH_CONFIG: Partial<Record<RouteKey, { queryKey: readonly string[]; queryFn: () => Promise<unknown> }>> = {
  '/docker': { queryKey: [...DOCKER_PRELOAD_KEY], queryFn: () => preloadDockerStats() },
  '/stacks': { queryKey: [...STACKS_QUERY_KEY], queryFn: () => listStacks() },
  '/zfs': { queryKey: [...ZFS_PRELOAD_KEY], queryFn: preloadZFSStats },
  '/proxmox': { queryKey: [...PROXMOX_PRELOAD_KEY], queryFn: preloadProxmoxStats },
}

const PREFETCH_STALE_TIME = 1_000

function handlePrefetch(route: RouteKey) {
  const config = PREFETCH_CONFIG[route]
  if (config) {
    queryClient.prefetchQuery({ ...config, staleTime: PREFETCH_STALE_TIME }).catch(() => {})
  }
}

function useCurrentTab(): RouteKey {
  const pathname = useLocation({ select: (l) => l.pathname })
  const match = NAV_ITEMS.find(
    (item) => pathname === item.to || pathname.startsWith(item.to + '/'),
  )
  return match?.to ?? '/docker'
}


interface MenuController {
  openId: RouteKey | null
  requestOpen: (id: RouteKey) => void
  requestClose: () => void
  closeNow: () => void
}

function useMenuController(): MenuController {
  const [openId, setOpenId] = useState<RouteKey | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelTimer = () => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }

  useEffect(() => () => cancelTimer(), [])

  const requestOpen = useCallback((id: RouteKey) => {
    cancelTimer()
    setOpenId(id)
  }, [])

  const requestClose = useCallback(() => {
    cancelTimer()
    timer.current = setTimeout(() => setOpenId(null), MENU_CLOSE_DELAY_MS)
  }, [])

  const closeNow = useCallback(() => {
    cancelTimer()
    setOpenId(null)
  }, [])

  return { openId, requestOpen, requestClose, closeNow }
}

const NavMenuCloseContext = createContext<() => void>(() => {})

const MENU_ITEM_CLASSES =
  'flex items-center gap-2 px-3 py-2 text-sm no-underline text-inherit ' +
  'hover:bg-[var(--mui-palette-action-hover)] transition-colors'

function SettingsMenuContent() {
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

function StacksMenuContent() {
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
    return <div className="px-3 py-2 text-sm text-[var(--mui-palette-error-main)]">Failed to load stacks</div>
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
              <span className="w-4 h-4 rounded-sm bg-[var(--mui-palette-action-disabledBackground)] flex items-center justify-center text-[10px] font-bold opacity-50">
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

function DockerHostsMenuContent() {
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
    return <div className="px-3 py-2 text-sm text-[var(--mui-palette-error-main)]">Failed to load hosts</div>
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

function MenuContentFor({ to }: Readonly<{ to: RouteKey }>) {
  if (to === '/settings') return <SettingsMenuContent />
  if (to === '/stacks') return <StacksMenuContent />
  if (to === '/docker') return <DockerHostsMenuContent />
  return null
}

function DemoBanner() {
  const [visible, setVisible] = useState(true)
  if (!visible) return null
  return (
    <div className="absolute left-1/2 -translate-x-1/2 top-full pt-2 pointer-events-auto w-fit">
      <Alert severity="info" onClose={() => setVisible(false)}>
        <strong>Demo mode:</strong> all data is generated in the browser.
        {' '}Self-host to connect to your own infrastructure.
        {' '}
        <MuiLink href="https://github.com/jaredglaser/homelab-manager/blob/main/self-hosting/README.md" target="_blank" rel="noopener noreferrer">
          Self-host guide
        </MuiLink>
        {' '}&middot;{' '}
        <MuiLink href="https://github.com/jaredglaser/homelab-manager" target="_blank" rel="noopener noreferrer">
          GitHub
        </MuiLink>
      </Alert>
    </div>
  )
}

export default function Header() {
  const currentTab = useCurrentTab()
  const controller = useMenuController()
  const [anchors, setAnchors] = useState<Partial<Record<RouteKey, HTMLElement>>>({})

  // Stable callback refs keyed by route, so each Tab keeps the same setter
  // across renders. The null (unmount) case is ignored because these Tab
  // elements are persistent; anchors only need to be set once on mount.
  const refSetters = useMemo(() => {
    const setters: Partial<Record<RouteKey, (el: HTMLElement | null) => void>> = {}
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
        className="flex items-center rounded-2xl px-3 py-1 pointer-events-auto backdrop-blur-xl bg-[var(--mui-palette-background-paper)]/75 border border-[var(--mui-palette-divider)]/30 shadow-[0_8px_32px_var(--mui-palette-common-black)]/10"
      >
        <Tabs value={currentTab} aria-label="Main navigation" className="!min-h-0">
          {NAV_ITEMS.map((item) => {
            const { Icon } = item
            return (
              <Tab
                key={item.to}
                value={item.to}
                ref={refSetters[item.to]}
                label={
                  <span className="inline-flex items-center gap-1">
                    {item.label}
                    {item.hasMenu && <ChevronDown size={14} className="opacity-60" />}
                  </span>
                }
                icon={<Icon size={18} />}
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
                className="!min-h-0 !py-2"
              />
            )
          })}
        </Tabs>

        <div className="ml-auto pl-3 border-l border-[var(--mui-palette-divider)]/30">
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
            className="!z-50"
          >
            <Paper
              elevation={4}
              className="!rounded-xl !backdrop-blur-xl !bg-[var(--mui-palette-background-paper)]/95 border border-[var(--mui-palette-divider)]/30 overflow-hidden min-w-56 pointer-events-auto"
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

      {import.meta.env.VITE_DEMO_MODE === 'true' && <DemoBanner />}
    </header>
  )
}

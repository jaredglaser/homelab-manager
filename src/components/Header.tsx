import Tabs from '@mui/material/Tabs'
import Tab from '@mui/material/Tab'
import Alert from '@mui/material/Alert'
import MuiLink from '@mui/material/Link'
import { Link, useLocation } from '@tanstack/react-router'
import { HardDrive, Layers, Settings } from 'lucide-react'
import ModeToggle from '@/components/ModeToggle'
import { queryClient } from '@/components/AppShell'
import {
  DOCKER_PRELOAD_KEY, ZFS_PRELOAD_KEY, PROXMOX_PRELOAD_KEY,
  preloadDockerStats, preloadZFSStats, preloadProxmoxStats,
} from '@/lib/constants/preload-queries'
import { STACKS_QUERY_KEY } from '@/lib/constants/stacks-keys'
import { useState } from 'react'

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

type NavIcon = React.ComponentType<{ size?: number }>

const NAV_ITEMS: { to: '/docker' | '/stacks' | '/zfs' | '/proxmox' | '/settings'; label: string; icon: NavIcon }[] = [
  { to: '/docker', label: 'Docker', icon: DockerIcon },
  { to: '/stacks', label: 'Stacks', icon: Layers },
  { to: '/zfs', label: 'ZFS', icon: HardDrive },
  { to: '/proxmox', label: 'Proxmox', icon: ProxmoxIcon },
  { to: '/settings', label: 'Settings', icon: Settings },
]

export const NAV_ORDER: Record<string, number> = Object.fromEntries(
  NAV_ITEMS.map((item, index) => [item.to, index]),
)

function useCurrentTab(): string {
  const pathname = useLocation({ select: (l) => l.pathname })
  const match = NAV_ITEMS.find(
    (item) => pathname === item.to || pathname.startsWith(item.to + '/'),
  )
  return match?.to ?? '/docker'
}

const PREFETCH_CONFIG: Partial<Record<string, { queryKey: readonly string[]; queryFn: () => Promise<unknown> }>> = {
  '/docker': { queryKey: [...DOCKER_PRELOAD_KEY], queryFn: () => preloadDockerStats() },
  '/stacks': { queryKey: [...STACKS_QUERY_KEY], queryFn: async () => { const { listStacks } = await import('@/data/stacks/functions'); return listStacks(); } },
  '/zfs': { queryKey: [...ZFS_PRELOAD_KEY], queryFn: preloadZFSStats },
  '/proxmox': { queryKey: [...PROXMOX_PRELOAD_KEY], queryFn: preloadProxmoxStats },
}

const PREFETCH_STALE_TIME = 1_000

function handlePrefetch(route: string) {
  const config = PREFETCH_CONFIG[route]
  if (config) {
    queryClient.prefetchQuery({ ...config, staleTime: PREFETCH_STALE_TIME }).catch(() => {})
  }
}

function DemoBanner() {
  const [visible, setVisible] = useState(true)
  if (!visible) return null
  return (
    <div className="absolute left-1/2 -translate-x-1/2 top-full pt-2 pointer-events-auto w-fit">
      <div className="mx-auto max-w-5xl">
      <Alert severity="info" onClose={() => setVisible(false)}>
        <strong>Demo mode</strong> &mdash; all data is generated in the browser.
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
    </div>
  )
}

export default function Header() {
  const currentTab = useCurrentTab()

  return (
    <header className="sticky top-0 z-50 pt-3 pb-2 px-4 pointer-events-none">
      <nav className="mx-auto max-w-5xl flex items-center rounded-2xl px-6 py-1 pointer-events-auto backdrop-blur-xl bg-[var(--mui-palette-background-paper)]/75 border border-[var(--mui-palette-divider)]/30 shadow-[0_8px_32px_var(--mui-palette-common-black)]/10">
        <Tabs
          value={currentTab}
          aria-label="Main navigation"
          className="!min-h-0"
        >
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <Tab
              key={to}
              value={to}
              label={label}
              icon={<Icon size={18} />}
              iconPosition="start"
              component={Link}
              to={to}
              disableRipple
              onMouseEnter={() => handlePrefetch(to)}
              className="!min-h-0 !py-2"
            />
          ))}
        </Tabs>

        <div className="ml-auto border-l border-[var(--mui-palette-divider)]/30 pl-3">
          <ModeToggle />
        </div>
      </nav>
      {import.meta.env.VITE_DEMO_MODE === 'true' && <DemoBanner />}
    </header>
  )
}

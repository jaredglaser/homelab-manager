import Tabs from '@mui/material/Tabs'
import Tab from '@mui/material/Tab'
import { Link, useLocation } from '@tanstack/react-router'
import { Container, HardDrive, Server, Settings } from 'lucide-react'
import ModeToggle from '@/components/ModeToggle'
import type { LucideIcon } from 'lucide-react'

const NAV_ITEMS: { to: '/' | '/zfs' | '/proxmox' | '/settings'; label: string; icon: LucideIcon }[] = [
  { to: '/', label: 'Docker', icon: Container },
  { to: '/zfs', label: 'ZFS', icon: HardDrive },
  { to: '/proxmox', label: 'Proxmox', icon: Server },
  { to: '/settings', label: 'Settings', icon: Settings },
]

function useCurrentTab(): string {
  const pathname = useLocation({ select: (l) => l.pathname })
  const match = NAV_ITEMS.find(
    (item) => item.to === '/' ? pathname === '/' : pathname.startsWith(item.to),
  )
  return match?.to ?? '/'
}

export default function Header() {
  const currentTab = useCurrentTab()

  return (
    <header className="sticky top-0 z-50 pt-3 pb-2 px-4">
      <nav className="mx-auto max-w-5xl flex items-center rounded-2xl px-6 py-1 backdrop-blur-xl bg-[var(--mui-palette-background-paper)]/75 border border-[var(--mui-palette-divider)]/30 shadow-[0_8px_32px_var(--mui-palette-common-black)]/10">
        <Tabs
          value={currentTab}
          aria-label="Main navigation"
          sx={{ minHeight: 0 }}
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
              sx={{ minHeight: 0, py: 1 }}
            />
          ))}
        </Tabs>

        <div className="ml-auto border-l border-[var(--mui-palette-divider)]/30 pl-3">
          <ModeToggle />
        </div>
      </nav>
    </header>
  )
}

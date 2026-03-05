import { Link } from '@tanstack/react-router'
import { Container, HardDrive, Server, Settings } from 'lucide-react'
import ModeToggle from '@/components/ModeToggle'
import type { LucideIcon } from 'lucide-react'

interface NavItem {
  to: '/' | '/zfs' | '/proxmox' | '/settings'
  label: string
  icon: LucideIcon
  exact?: boolean
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Docker', icon: Container, exact: true },
  { to: '/zfs', label: 'ZFS', icon: HardDrive },
  { to: '/proxmox', label: 'Proxmox', icon: Server },
  { to: '/settings', label: 'Settings', icon: Settings },
]

export default function Header() {
  return (
    <header className="sticky top-0 z-50 pt-3 pb-2 px-4">
      <nav className="mx-auto max-w-5xl flex items-center rounded-2xl px-6 py-3 backdrop-blur-xl bg-[var(--mui-palette-background-paper)]/75 border border-[var(--mui-palette-divider)]/30 shadow-[0_8px_32px_var(--mui-palette-common-black)]/10">
        <div className="flex items-center gap-1">
          {NAV_ITEMS.map(({ to, label, icon: Icon, exact }) => (
            <Link
              key={to}
              to={to}
              activeOptions={exact ? { exact: true } : undefined}
              activeProps={{
                className:
                  'text-[var(--mui-palette-primary-main)] bg-[var(--mui-palette-primary-main)]/8 shadow-[0_4px_16px_var(--mui-palette-primary-main)]/40',
              }}
              inactiveProps={{
                className:
                  'text-[var(--mui-palette-text-secondary)] hover:bg-[var(--mui-palette-action-hover)] hover:text-[var(--mui-palette-text-primary)]',
              }}
              className="flex items-center gap-2 px-4 py-2 rounded-xl transition-all duration-200 text-sm font-medium"
            >
              <Icon size={18} />
              {label}
            </Link>
          ))}
        </div>

        <div className="ml-auto border-l border-[var(--mui-palette-divider)]/30 pl-3">
          <ModeToggle />
        </div>
      </nav>
    </header>
  )
}

import { Link } from '@tanstack/react-router'
import ModeToggle from './ModeToggle'

export default function Header() {
  return (
    <header className="sticky top-0 z-50 backdrop-blur-xl bg-white/70 dark:bg-[#1c1c1e]/70 border-b border-black/[0.06] dark:border-white/[0.08] shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
      <div className="flex items-center justify-between px-4 h-12">
        <nav className="flex items-center gap-1">
          <NavLink to="/" label="Docker" exact />
          <NavLink to="/zfs" label="ZFS" />
          <NavLink to="/settings" label="Settings" />
        </nav>
        <ModeToggle />
      </div>
    </header>
  )
}

function NavLink({ to, label, exact }: { to: string; label: string; exact?: boolean }) {
  return (
    <Link
      to={to}
      activeOptions={exact ? { exact: true } : undefined}
      className="px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-200"
      activeProps={{
        className: 'bg-[var(--joy-palette-primary-softBg)] text-[var(--joy-palette-primary-500)]',
      }}
      inactiveProps={{
        className: 'text-[var(--joy-palette-text-secondary)] hover:text-[var(--joy-palette-text-primary)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]',
      }}
    >
      {label}
    </Link>
  )
}

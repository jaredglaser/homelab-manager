import { Link } from '@tanstack/react-router'
import ModeToggle from './ModeToggle'
import { useSettings } from '@/hooks/useSettings'

export default function Header() {
  const { developer } = useSettings();

  return (
    <header className="p-1 flex gap-1 bg-[var(--joy-palette-background-surface)] text-[var(--joy-palette-text-primary)] justify-between items-center border-b border-[var(--joy-palette-divider)]">
      <nav className="flex flex-row gap-2">
        <span className="px-1 font-bold">
          <Link to="/">Docker</Link>
        </span>
        <span className="px-1 font-bold">
          <Link to="/zfs">ZFS</Link>
        </span>
        {developer.showDatabaseDebug && (
          <span className="px-1 font-bold">
            <Link to="/debug-db">DB Debug</Link>
          </span>
        )}
        <span className="px-1 font-bold">
          <Link to="/settings">Settings</Link>
        </span>
      </nav>
      <ModeToggle />
    </header>
  )
}

import { Link } from '@tanstack/react-router'
import ModeToggle from './ModeToggle'

/**
 * Renders the application header with primary navigation and a mode toggle.
 *
 * The header includes links to "Docker", "ZFS", "Proxmox", and "Settings", and places
 * a ModeToggle component to the right. Styling uses theme-aware CSS variables for
 * background, text, and divider colors.
 *
 * @returns The header element containing navigation and the mode toggle
 */
export default function Header() {
  return (
    <header className="p-1 flex gap-1 bg-[var(--mui-palette-background-paper)] text-[var(--mui-palette-text-primary)] justify-between items-center border-b border-[var(--mui-palette-divider)]">
      <nav className="flex flex-row gap-2">
        <span className="px-1 font-bold">
          <Link to="/">Docker</Link>
        </span>
        <span className="px-1 font-bold">
          <Link to="/zfs">ZFS</Link>
        </span>
        <span className="px-1 font-bold">
          <Link to="/proxmox">Proxmox</Link>
        </span>
        <span className="px-1 font-bold">
          <Link to="/settings">Settings</Link>
        </span>
      </nav>
      <ModeToggle />
    </header>
  )
}

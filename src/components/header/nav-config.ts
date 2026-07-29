import { Archive, Code, HardDrive, Layers, Server, Settings as SettingsIcon, SlidersHorizontal } from 'lucide-react'
import { DockerIcon, ProxmoxIcon } from '@/components/header/icons'
import type { IconProps } from '@/components/header/icons'
import { queryClient } from '@/lib/query-client'
import {
  DOCKER_PRELOAD_KEY, ZFS_PRELOAD_KEY, PROXMOX_PRELOAD_KEY,
  preloadDockerStats, preloadZFSStats, preloadProxmoxStats,
} from '@/lib/constants/preload-queries'
import { STACKS_QUERY_KEY } from '@/lib/constants/stacks-keys'
import { listStacks } from '@/data/stacks/functions'
import type { SettingsSectionId } from '@/lib/constants/settings-sections'

export type { SettingsSectionId }

// The drawer header reproduces this box structure so its hamburger lands on the bar's
// by construction; copying the resulting coordinates would desync on the next change.
export const HEADER_INSET_CLASSES =
  'px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2'

export const NAV_ROW_CLASSES =
  'flex h-12 items-center min-w-0 rounded-2xl px-3 border'

export type MenuRouteKey = '/docker' | '/stacks' | '/settings'
export type RouteKey = MenuRouteKey | '/zfs' | '/proxmox'

export type NoMenuNavItem = {
  to: Exclude<RouteKey, MenuRouteKey>
  label: string
  Icon: React.ComponentType<IconProps>
  hasMenu: false
}

export type MenuNavItem = {
  to: MenuRouteKey
  label: string
  Icon: React.ComponentType<IconProps>
  hasMenu: true
  /**
   * Drawer-only row pointing at the route itself. Needed only where the menu
   * entries navigate somewhere else; Docker and Settings entries are anchors on
   * the parent page, so any of them already lands there.
   */
  selfEntryLabel?: string
}

export type NavItem = NoMenuNavItem | MenuNavItem

export function menuRouteFor(
  item: NavItem,
  menuRoutes: ReadonlySet<MenuRouteKey>,
): MenuRouteKey | null {
  return item.hasMenu && menuRoutes.has(item.to) ? item.to : null
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/docker', label: 'Docker', Icon: DockerIcon, hasMenu: true },
  { to: '/stacks', label: 'Stacks', Icon: Layers, hasMenu: true, selfEntryLabel: 'All stacks' },
  { to: '/zfs', label: 'ZFS', Icon: HardDrive, hasMenu: false },
  { to: '/proxmox', label: 'Proxmox', Icon: ProxmoxIcon, hasMenu: false },
  { to: '/settings', label: 'Settings', Icon: SettingsIcon, hasMenu: true },
]

export interface SettingsSectionDescriptor {
  id: SettingsSectionId
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

export const PREFETCH_STALE_TIME = 1_000

export function handlePrefetch(route: RouteKey) {
  const config = PREFETCH_CONFIG[route]
  if (config) {
    queryClient.prefetchQuery({ ...config, staleTime: PREFETCH_STALE_TIME }).catch((err) => console.error('[nav-config] prefetch failed:', err))
  }
}

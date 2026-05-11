import { Archive, Code, HardDrive, Layers, Server, Settings as SettingsIcon, SlidersHorizontal } from 'lucide-react'
import { DockerIcon, ProxmoxIcon } from '@/components/header/icons'
import type { IconProps } from '@/components/header/icons'
import { queryClient } from '@/components/AppShell'
import {
  DOCKER_PRELOAD_KEY, ZFS_PRELOAD_KEY, PROXMOX_PRELOAD_KEY,
  preloadDockerStats, preloadZFSStats, preloadProxmoxStats,
} from '@/lib/constants/preload-queries'
import { STACKS_QUERY_KEY } from '@/lib/constants/stacks-keys'
import { listStacks } from '@/data/stacks/functions'

export type RouteKey = '/docker' | '/stacks' | '/zfs' | '/proxmox' | '/settings'

export interface NavItem {
  to: RouteKey
  label: string
  Icon: React.ComponentType<IconProps>
  hasMenu: boolean
  // Brand SVGs (Docker, Proxmox) lack the small transparent padding lucide
  // icons bake into their viewBoxes, so they read as too close to the tab
  // label even with MUI's iconWrapper margin. This flag lets the Tab strip
  // add a touch of extra right margin without affecting dropdown contexts
  // that already use flex `gap-*` for spacing.
  customIcon?: boolean
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/docker', label: 'Docker', Icon: DockerIcon, hasMenu: true, customIcon: true },
  { to: '/stacks', label: 'Stacks', Icon: Layers, hasMenu: true },
  { to: '/zfs', label: 'ZFS', Icon: HardDrive, hasMenu: false },
  { to: '/proxmox', label: 'Proxmox', Icon: ProxmoxIcon, hasMenu: false, customIcon: true },
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

export const PREFETCH_STALE_TIME = 1_000

export function handlePrefetch(route: RouteKey) {
  const config = PREFETCH_CONFIG[route]
  if (config) {
    queryClient.prefetchQuery({ ...config, staleTime: PREFETCH_STALE_TIME }).catch(() => {})
  }
}

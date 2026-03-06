import { getHistoricalDockerStats } from '@/data/docker.functions'
import { getHistoricalZFSStats } from '@/data/zfs.functions'
import { getHistoricalProxmoxStats } from '@/data/proxmox.functions'

export const DOCKER_PRELOAD_KEY = ['preload', 'docker-stats'] as const
export const ZFS_PRELOAD_KEY = ['preload', 'zfs-stats'] as const
export const PROXMOX_PRELOAD_KEY = ['preload', 'proxmox-stats'] as const

export const PRELOAD_STALE_TIME = 30_000

export function preloadDockerStats(seconds = 90) {
  return getHistoricalDockerStats({ data: { seconds } })
}

export function preloadZFSStats() {
  return getHistoricalZFSStats({ data: { seconds: 90 } })
}

export function preloadProxmoxStats() {
  return getHistoricalProxmoxStats({ data: { seconds: 120 } })
}

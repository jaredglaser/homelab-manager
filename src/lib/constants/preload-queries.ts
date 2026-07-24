import { getHistoricalDockerStats } from '@/data/docker/functions'
import { getHistoricalZFSStats } from '@/data/zfs/functions'
import { getHistoricalProxmoxStats } from '@/data/proxmox/functions'

export const DOCKER_PRELOAD_KEY = ['preload', 'docker-stats'] as const
export const ZFS_PRELOAD_KEY = ['preload', 'zfs-stats'] as const
export const PROXMOX_PRELOAD_KEY = ['preload', 'proxmox-stats'] as const

export const PRELOAD_STALE_TIME = 30_000

// Sparklines always show the last 35s (10s padding = 45s buffer); the docker
// stream window must cover both the chart and sparkline requirements.
export const DOCKER_SPARKLINE_BUFFER_SECONDS = 45

export function dockerStatsWindowSeconds(chartWindowSeconds: number) {
  return Math.max(chartWindowSeconds + 10, DOCKER_SPARKLINE_BUFFER_SECONDS)
}

// Window is part of the key because different windows return different bucket
// resolutions. AppShell's warm-up and the route must build it through this
// helper or they warm separate entries.
export function dockerPreloadQueryKey(windowSeconds: number) {
  return [...DOCKER_PRELOAD_KEY, windowSeconds] as const
}

export function preloadDockerStats(seconds = 90) {
  return getHistoricalDockerStats({ data: { seconds } })
}

export function preloadZFSStats() {
  return getHistoricalZFSStats({ data: { seconds: 90 } })
}

export function preloadProxmoxStats() {
  return getHistoricalProxmoxStats({ data: { seconds: 120 } })
}

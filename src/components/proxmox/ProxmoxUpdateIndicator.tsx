import { useEffect, useRef } from 'react'
import TapTooltip from '@/components/ui/tap-tooltip'
import { useAtomValue } from 'jotai'
import { proxmoxLastUpdateAtom } from '@/hooks/settingsAtom'

export function UpdateIndicator({ expectedInterval }: { expectedInterval: number }) {
  const lastUpdate = useAtomValue(proxmoxLastUpdateAtom)
  const dotRef = useRef<HTMLDivElement>(null)
  const pingRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const dot = dotRef.current
    const ping = pingRef.current

    if (lastUpdate === 0) {
      if (dot) { dot.className = 'absolute w-2 h-2 rounded-full transition-all duration-300 bg-neutral-400 opacity-40' }
      if (ping) { ping.className = 'absolute w-2 h-2 bg-neutral-400 rounded-full opacity-0' }
      return
    }

    // Reset to active state
    if (dot) { dot.className = 'absolute w-2 h-2 rounded-full transition-all duration-300 bg-green-500 opacity-100' }
    if (ping) { ping.className = 'absolute w-2 h-2 bg-green-500 rounded-full animate-ping opacity-75' }

    const pulseTimer = setTimeout(() => {
      if (ping) { ping.className = 'absolute w-2 h-2 bg-green-500 rounded-full opacity-0' }
    }, 1000)

    // After twice the expected interval plus a 5s grace period, dim the dot to signal stale data
    const lateThreshold = expectedInterval * 2 + 5000
    const lateCheckTimer = setTimeout(() => {
      if (dot) { dot.className = 'absolute w-2 h-2 rounded-full transition-all duration-300 bg-orange-500 opacity-30' }
      if (ping) { ping.className = 'absolute w-2 h-2 bg-green-500 rounded-full opacity-0' }
    }, lateThreshold)

    return () => {
      clearTimeout(pulseTimer)
      clearTimeout(lateCheckTimer)
    }
  }, [lastUpdate, expectedInterval])

  const lastUpdatedDate = lastUpdate > 0 ? new Date(lastUpdate) : null
  const tooltipTitle = lastUpdatedDate
    ? `Last updated: ${lastUpdatedDate.toLocaleTimeString()}`
    : 'No data yet'

  return (
    <TapTooltip content={tooltipTitle} className="inline-flex tap-target">
      <div
        className="relative inline-flex items-center justify-center w-2 h-2"
        role="status"
        aria-label={tooltipTitle}
        tabIndex={0}
      >
        <div
          ref={dotRef}
          className="absolute w-2 h-2 rounded-full transition-all duration-300 bg-neutral-400 opacity-40"
        />
        <div
          ref={pingRef}
          className="absolute w-2 h-2 bg-green-500 rounded-full opacity-0"
        />
      </div>
    </TapTooltip>
  )
}

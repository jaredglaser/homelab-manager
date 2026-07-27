import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Zap, Waves } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsTouch } from '@/hooks/useMediaQuery'
import type { ProxmoxUpdateInterval } from '@/hooks/useSettings'

/**
 * Base UI's Tooltip only opens for mouse/pen pointer types, so a tap on a touch
 * device never reveals it. Controlling Root's `open` prop from a tap does not
 * open the popup either: Root only shows content for the trigger it tracked
 * through its own hover/focus/press interactions. So touch gets an entirely
 * separate, manually positioned popup (mirroring ui/tap-tooltip's approach)
 * instead of trying to drive Root's controlled `open`. It can't reuse
 * ui/tap-tooltip directly: that wraps its trigger in a span, and
 * ToggleGroupItem's rounded-corner classes are first/last-child selectors
 * that depend on staying a direct DOM sibling of the other item.
 */
function useTapPopup() {
  const isTouch = useIsTouch()
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const el = triggerRef.current
    if (!el || !isTouch) return
    const handleClick = () => {
      setPos((current) => {
        if (current !== null) return null
        const r = el.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top }
      })
    }
    el.addEventListener('click', handleClick)
    return () => el.removeEventListener('click', handleClick)
  }, [isTouch])

  useEffect(() => {
    if (!isTouch || pos === null) return
    function dismissIfOutside(e: PointerEvent) {
      if (triggerRef.current && !triggerRef.current.contains(e.target as Node)) setPos(null)
    }
    document.addEventListener('pointerdown', dismissIfOutside)
    return () => document.removeEventListener('pointerdown', dismissIfOutside)
  }, [isTouch, pos])

  return { triggerRef, pos }
}

function TapPopup({ pos, children }: Readonly<{ pos: { x: number; y: number } | null; children: ReactNode }>) {
  if (pos === null) return null
  return createPortal(
    <div
      className="fixed z-[9999] -translate-x-1/2 -translate-y-[calc(100%+6px)] rounded-lg px-2 py-1 bg-tooltip/92 text-tooltip-foreground max-w-75 break-words"
      style={{ left: pos.x, top: pos.y }}
      role="tooltip"
    >
      {children}
    </div>,
    document.body,
  )
}

export function IntervalToggle({
  interval,
  onIntervalChange
}: {
  interval: ProxmoxUpdateInterval
  onIntervalChange: (interval: ProxmoxUpdateInterval) => void
}) {
  const fastPopup = useTapPopup()
  const relaxedPopup = useTapPopup()

  const fastContent = (
    <div className="flex flex-col gap-1">
      <p className="text-sm">Fast updates (1 second)</p>
      <Badge variant="warning">Increases API load on Proxmox</Badge>
    </div>
  )
  const relaxedContent = (
    <div className="flex flex-col gap-1">
      <p className="text-sm">Relaxed updates (10 seconds)</p>
      <Badge variant="success">Recommended for most users</Badge>
    </div>
  )

  return (
    <>
      <ToggleGroup
        value={[String(interval)]}
        onValueChange={(groupValue) => {
          const newValue = groupValue[0]
          if (newValue !== undefined) onIntervalChange(Number(newValue) as ProxmoxUpdateInterval)
        }}
        aria-label="Update interval"
      >
        <Tooltip>
          <TooltipTrigger
            render={<ToggleGroupItem ref={fastPopup.triggerRef} value="1000" aria-label="1 second (fast)" />}
          >
            <Zap size={16} />
          </TooltipTrigger>
          <TooltipContent side="bottom">{fastContent}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={<ToggleGroupItem ref={relaxedPopup.triggerRef} value="10000" aria-label="10 seconds (relaxed)" />}
          >
            <Waves size={16} />
          </TooltipTrigger>
          <TooltipContent side="bottom">{relaxedContent}</TooltipContent>
        </Tooltip>
      </ToggleGroup>
      <TapPopup pos={fastPopup.pos}>{fastContent}</TapPopup>
      <TapPopup pos={relaxedPopup.pos}>{relaxedContent}</TapPopup>
    </>
  )
}

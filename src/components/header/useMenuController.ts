import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from '@tanstack/react-router'
import { MENU_CLOSE_DELAY_MS } from '@/lib/constants/ui-timing'
import type { RouteKey } from '@/components/header/nav-config'
import { NAV_ITEMS } from '@/components/header/nav-config'

export interface MenuController {
  openId: RouteKey | null
  requestOpen: (id: RouteKey) => void
  requestClose: () => void
  closeNow: () => void
}

export function useMenuController(): MenuController {
  const [openId, setOpenId] = useState<RouteKey | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelTimer = () => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }

  useEffect(() => () => cancelTimer(), [])

  const requestOpen = useCallback((id: RouteKey) => {
    cancelTimer()
    setOpenId(id)
  }, [])

  const requestClose = useCallback(() => {
    cancelTimer()
    timer.current = setTimeout(() => setOpenId(null), MENU_CLOSE_DELAY_MS)
  }, [])

  const closeNow = useCallback(() => {
    cancelTimer()
    setOpenId(null)
  }, [])

  return { openId, requestOpen, requestClose, closeNow }
}

export function useCurrentTab(): RouteKey {
  const pathname = useLocation({ select: (l) => l.pathname })
  const match = NAV_ITEMS.find(
    (item) => pathname === item.to || pathname.startsWith(item.to + '/'),
  )
  return match?.to ?? '/docker'
}

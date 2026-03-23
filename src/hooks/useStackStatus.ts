import { useEffect, useState } from 'react'
import { apiUrl } from '@/lib/utils/api-url'
import type { StackStatusEntry } from '@/types/stacks'

export function useStackStatus() {
  const [statusMap, setStatusMap] = useState<Map<string, StackStatusEntry>>(new Map())
  const [isConnected, setIsConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const source = new EventSource(apiUrl('/api/stack-status'))

    source.onopen = () => {
      setIsConnected(true)
      setError(null)
    }

    source.onmessage = (event) => {
      try {
        const entries: StackStatusEntry[] = JSON.parse(event.data)
        setStatusMap((prev) => {
          const next = new Map(prev)
          for (const e of entries) {
            next.set(`${e.stack}/${e.host}`, e)
          }
          return next
        })
      } catch {
        // Skip malformed events
      }
    }

    source.onerror = () => {
      setIsConnected(false)
      setError('Connection lost')
    }

    return () => {
      source.close()
    }
  }, [])

  return { statusMap, isConnected, error }
}

import { useEffect, useRef, useState } from 'react'
import { apiUrl } from '@/lib/utils/api-url'
import type { StackStatusEntry } from '@/types/stacks'

export function useStackStatus() {
  const [statusMap, setStatusMap] = useState<Map<string, StackStatusEntry>>(new Map())
  const [isConnected, setIsConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sourceRef = useRef<EventSource | null>(null)

  useEffect(() => {
    const source = new EventSource(apiUrl('/api/stack-status'))
    sourceRef.current = source

    source.onopen = () => {
      setIsConnected(true)
      setError(null)
    }

    source.onmessage = (event) => {
      try {
        const entries: StackStatusEntry[] = JSON.parse(event.data)
        setStatusMap(new Map(entries.map((e) => [`${e.stack}/${e.host}`, e])))
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
      sourceRef.current = null
    }
  }, [])

  return { statusMap, isConnected, error }
}

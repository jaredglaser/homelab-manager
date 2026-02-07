import { useEffect, useState, useRef } from 'react';

interface UseSSEOptions<T> {
  url: string;
  onData: (data: T) => void;
}

interface UseSSEResult {
  isConnected: boolean;
  error: Error | null;
}

export function useSSE<T>({
  url,
  onData,
}: UseSSEOptions<T>): UseSSEResult {
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const onDataRef = useRef(onData);

  // Keep onData ref up to date
  onDataRef.current = onData;

  useEffect(() => {
    let mounted = true;

    const connect = () => {
      if (!mounted) return;

      const eventSource = new EventSource(url);
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        if (mounted) {
          setIsConnected(true);
          setError(null);
        }
      };

      eventSource.onmessage = (event) => {
        if (mounted) {
          try {
            const data = JSON.parse(event.data) as T;
            onDataRef.current(data);
          } catch (err) {
            console.error('[useSSE] Failed to parse message:', err);
          }
        }
      };

      eventSource.onerror = () => {
        if (mounted) {
          setIsConnected(false);
          // EventSource will auto-reconnect, so we don't set error immediately
          // Only set error if it's a persistent failure
        }
      };
    };

    connect();

    return () => {
      mounted = false;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [url]);

  return { isConnected, error };
}

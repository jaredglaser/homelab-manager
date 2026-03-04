import { useEffect, useState, useRef } from 'react';

const MAX_RECONNECT_ATTEMPTS = 5;

interface UseEventSourceOptions<T> {
  url: string;
  onData: (data: T) => void;
  onServiceError?: () => void;
  debug?: boolean;
}

interface UseEventSourceResult {
  isConnected: boolean;
  error: Error | null;
}

export function useEventSource<T>({
  url,
  onData,
  onServiceError,
  debug = false,
}: UseEventSourceOptions<T>): UseEventSourceResult {
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const onDataRef = useRef(onData);
  const onServiceErrorRef = useRef(onServiceError);
  const reconnectAttemptsRef = useRef(0);
  const messageCountRef = useRef(0);
  const lastMessageTimeRef = useRef(0);

  // Keep callback refs up to date
  onDataRef.current = onData;
  onServiceErrorRef.current = onServiceError;

  useEffect(() => {
    let mounted = true;

    const connect = () => {
      if (!mounted) return;

      if (debug) console.log(`[useEventSource] Connecting to ${url}`);
      const eventSource = new EventSource(url);
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        if (mounted) {
          setIsConnected(true);
          setError(null);
          reconnectAttemptsRef.current = 0;
          if (debug) console.log('[useEventSource] Connected');
        }
      };

      eventSource.onmessage = (event) => {
        if (mounted) {
          try {
            const now = performance.now();
            const timeSinceLastMessage = lastMessageTimeRef.current > 0
              ? now - lastMessageTimeRef.current
              : 0;
            lastMessageTimeRef.current = now;
            messageCountRef.current++;

            const data = JSON.parse(event.data) as T;
            const rowCount = Array.isArray(data) ? data.length : 1;

            if (debug) {
              console.log(
                `[useEventSource] Message #${messageCountRef.current}: ${rowCount} rows ` +
                `(${timeSinceLastMessage > 0 ? `${timeSinceLastMessage.toFixed(0)}ms since last` : 'first message'})`
              );
            }

            onDataRef.current(data);
          } catch (err) {
            console.error('[useEventSource] Failed to parse message:', err);
          }
        }
      };

      eventSource.addEventListener('stats_error', () => {
        if (mounted) onServiceErrorRef.current?.();
      });

      eventSource.onerror = () => {
        if (mounted) {
          setIsConnected(false);
          reconnectAttemptsRef.current++;

          if (debug) {
            console.warn(`[useEventSource] Connection error (attempt ${reconnectAttemptsRef.current}/${MAX_RECONNECT_ATTEMPTS})`);
          }

          // Close EventSource after multiple failed reconnection attempts
          // (without this, the browser's built-in auto-reconnect retries forever)
          if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
            setError(new Error('Connection failed after multiple attempts'));
            eventSource.close();
            eventSourceRef.current = null;
          }
        }
      };
    };

    connect();

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (eventSourceRef.current === null || eventSourceRef.current.readyState === EventSource.CLOSED) {
        reconnectAttemptsRef.current = 0;
        connect();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      mounted = false;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (eventSourceRef.current) {
        if (debug) console.log('[useEventSource] Closing connection');
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [url, debug]);

  return { isConnected, error };
}

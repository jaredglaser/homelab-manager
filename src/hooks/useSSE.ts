import { useEffect, useState, useRef } from 'react';

const MAX_RECONNECT_ATTEMPTS = 5;

interface UseSSEOptions<T> {
  url: string;
  onData: (data: T) => void;
  debug?: boolean;
}

interface UseSSEResult {
  isConnected: boolean;
  error: Error | null;
}

export function useSSE<T>({
  url,
  onData,
  debug = false,
}: UseSSEOptions<T>): UseSSEResult {
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const onDataRef = useRef(onData);
  const reconnectAttemptsRef = useRef(0);
  const messageCountRef = useRef(0);
  const lastMessageTimeRef = useRef(0);

  // Keep onData ref up to date
  onDataRef.current = onData;

  useEffect(() => {
    let mounted = true;

    const connect = () => {
      if (!mounted) return;

      if (debug) console.log(`[useSSE] Connecting to ${url}`);
      const eventSource = new EventSource(url);
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        if (mounted) {
          setIsConnected(true);
          setError(null);
          reconnectAttemptsRef.current = 0;
          if (debug) console.log('[useSSE] Connected');
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
                `[useSSE] Message #${messageCountRef.current}: ${rowCount} rows ` +
                `(${timeSinceLastMessage > 0 ? `${timeSinceLastMessage.toFixed(0)}ms since last` : 'first message'})`
              );
            }

            onDataRef.current(data);
          } catch (err) {
            console.error('[useSSE] Failed to parse message:', err);
          }
        }
      };

      eventSource.onerror = () => {
        if (mounted) {
          setIsConnected(false);
          reconnectAttemptsRef.current++;

          if (debug) {
            console.warn(`[useSSE] Connection error (attempt ${reconnectAttemptsRef.current}/${MAX_RECONNECT_ATTEMPTS})`);
          }

          // Set error after multiple failed reconnection attempts
          if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
            setError(new Error('Connection failed after multiple attempts'));
          }
        }
      };
    };

    connect();

    return () => {
      mounted = false;
      if (eventSourceRef.current) {
        if (debug) console.log('[useSSE] Closing connection');
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [url, debug]);

  return { isConnected, error };
}

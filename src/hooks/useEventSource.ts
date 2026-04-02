import { useEffect, useState, useRef } from 'react';

const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 16_000;

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

/**
 * Manages an EventSource connection to receive server-sent JSON messages and expose connection state.
 *
 * Establishes and maintains an EventSource for the given URL, parses incoming messages as JSON
 * and forwards them to `onData`, tracks connection status and errors, and reconnects with
 * exponential backoff (1s, 2s, 4s, 8s, 16s) up to MAX_RECONNECT_ATTEMPTS.
 * Re-establishes the connection when the document becomes visible again.
 */
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
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageCountRef = useRef(0);
  const lastMessageTimeRef = useRef(0);

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
        if (!mounted) return;
        // Ignore errors from a replaced EventSource instance
        if (eventSource !== eventSourceRef.current) return;
        setIsConnected(false);

        // Close current connection — we manage reconnection manually with backoff
        eventSource.close();
        eventSourceRef.current = null;

        if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
          if (reconnectTimerRef.current !== null) {
            clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = null;
          }
          setError(new Error('Connection failed after multiple attempts'));
          return;
        }

        reconnectAttemptsRef.current++;

        if (debug) {
          console.warn(`[useEventSource] Connection error (attempt ${reconnectAttemptsRef.current}/${MAX_RECONNECT_ATTEMPTS})`);
        }

        // Exponential backoff: 1s, 2s, 4s, 8s, 16s
        const delay = Math.min(
          BASE_BACKOFF_MS * 2 ** (reconnectAttemptsRef.current - 1),
          MAX_BACKOFF_MS,
        );

        if (debug) {
          console.info(`[useEventSource] Reconnecting in ${delay}ms`);
        }

        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          connect();
        }, delay);
      };
    };

    connect();

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (eventSourceRef.current === null && reconnectTimerRef.current === null) {
        reconnectAttemptsRef.current = 0;
        connect();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      mounted = false;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (eventSourceRef.current) {
        if (debug) console.log('[useEventSource] Closing connection');
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [url, debug]);

  return { isConnected, error };
}

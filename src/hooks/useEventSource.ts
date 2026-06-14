import { useEffect, useState, useRef } from 'react';

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 16_000;
// After this many consecutive failures the hook surfaces an error so the UI
// can show a degraded state. Reconnect attempts continue indefinitely: a
// continuously visible tab must recover on its own once the server is back.
const ERROR_AFTER_ATTEMPTS = 5;

interface UseEventSourceOptions<T> {
  url: string;
  onData: (data: T) => void;
  onServiceError?: () => void;
  /**
   * Fired on open after a prior connection failure (never on first connect).
   * SSE here carries snapshot metrics with no Last-Event-ID replay, so callers
   * use this to backfill the gap left by a dropped connection.
   */
  onReconnect?: () => void;
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
 * exponential backoff (1s, 2s, 4s, 8s, then 16s) indefinitely, surfacing `error` after
 * ERROR_AFTER_ATTEMPTS consecutive failures. Re-establishes the connection when the document
 * becomes visible again and when the browser comes back online.
 */
export function useEventSource<T>({
  url,
  onData,
  onServiceError,
  onReconnect,
  debug = false,
}: UseEventSourceOptions<T>): UseEventSourceResult {
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const onDataRef = useRef(onData);
  const onServiceErrorRef = useRef(onServiceError);
  const onReconnectRef = useRef(onReconnect);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageCountRef = useRef(0);
  const lastMessageTimeRef = useRef(0);
  const hadErrorRef = useRef(false);

  onDataRef.current = onData;
  onServiceErrorRef.current = onServiceError;
  onReconnectRef.current = onReconnect;

  useEffect(() => {
    let mounted = true;

    // Reset retry budget and error state on each (re-)subscribe so a new URL
    // starts fresh rather than inheriting exhausted retry state from a prior URL.
    reconnectAttemptsRef.current = 0;
    hadErrorRef.current = false;
    setError(null);

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
          if (hadErrorRef.current) {
            hadErrorRef.current = false;
            onReconnectRef.current?.();
          }
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
            console.error('[useEventSource] Failed to parse message:', err, `payload length=${event.data?.length ?? 0}`);
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
        hadErrorRef.current = true;
        setIsConnected(false);

        // Close current connection: we manage reconnection manually with backoff
        eventSource.close();
        eventSourceRef.current = null;

        reconnectAttemptsRef.current++;

        if (reconnectAttemptsRef.current > ERROR_AFTER_ATTEMPTS) {
          setError(new Error('Connection failed after multiple attempts'));
        }

        if (debug) {
          console.warn(`[useEventSource] Connection error (attempt ${reconnectAttemptsRef.current})`);
        }

        // Exponential backoff: 1s, 2s, 4s, 8s, then 16s indefinitely
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

    // Network came back: skip the remaining backoff delay and reconnect now
    // with a fresh retry budget instead of waiting out a 16s timer.
    const handleOnline = () => {
      if (eventSourceRef.current !== null) return;
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      reconnectAttemptsRef.current = 0;
      connect();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('online', handleOnline);

    return () => {
      mounted = false;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', handleOnline);
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

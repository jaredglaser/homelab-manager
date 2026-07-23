import { useEffect, useState, useRef } from 'react';
import { createReconnectingEventSource } from '@/lib/streaming/reconnecting-event-source';

// After this many failed attempts the error surfaces to the caller, but reconnect
// attempts continue indefinitely: a continuously visible tab must recover on its
// own once the server is back, however long that takes.
const ERROR_AFTER_ATTEMPTS = 5;

interface UseEventSourceOptions<T> {
  url: string;
  onData: (data: T) => void;
  onServiceError?: () => void;
  /** Fired on reconnect open, not first connect: SSE here has no Last-Event-ID replay, so callers backfill the gap themselves. */
  onReconnect?: () => void;
  /** Default `stats_error`; broadcast endpoints pass their own name (`settings_error`, `inventory_error`, `stack_status_error`). */
  errorEventName?: string;
  debug?: boolean;
}

interface UseEventSourceResult {
  isConnected: boolean;
  error: Error | null;
}

/** React wrapper over the shared reconnect primitive: JSON message parsing plus connection state. */
export function useEventSource<T>({
  url,
  onData,
  onServiceError,
  onReconnect,
  errorEventName = 'stats_error',
  debug = false,
}: UseEventSourceOptions<T>): UseEventSourceResult {
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const onDataRef = useRef(onData);
  const onServiceErrorRef = useRef(onServiceError);
  const onReconnectRef = useRef(onReconnect);
  const messageCountRef = useRef(0);
  const lastMessageTimeRef = useRef(0);
  const hadErrorRef = useRef(false);

  onDataRef.current = onData;
  onServiceErrorRef.current = onServiceError;
  onReconnectRef.current = onReconnect;

  useEffect(() => {
    let mounted = true;

    // A new URL starts fresh, not inheriting exhausted retry state from the prior one.
    hadErrorRef.current = false;
    setError(null);

    const handle = createReconnectingEventSource({
      url,
      reconnectOnVisibility: true,
      reconnectOnOnline: true,
      errorThreshold: ERROR_AFTER_ATTEMPTS,
      namedEvents: [errorEventName],

      onConnecting: () => {
        if (debug) console.log(`[useEventSource] Connecting to ${url}`);
      },

      onOpen: () => {
        if (!mounted) return;
        setIsConnected(true);
        setError(null);
        if (hadErrorRef.current) {
          hadErrorRef.current = false;
          onReconnectRef.current?.();
        }
        if (debug) console.log('[useEventSource] Connected');
      },

      onMessage: (event) => {
        if (!mounted) return;
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
      },

      onNamedEvent: () => {
        if (mounted) onServiceErrorRef.current?.();
      },

      onError: () => {
        if (!mounted) return;
        hadErrorRef.current = true;
        setIsConnected(false);
      },

      onErrorThreshold: () => {
        if (mounted) setError(new Error('Connection failed after multiple attempts'));
      },

      onScheduleRetry: (attempt, delay) => {
        if (debug) {
          console.warn(`[useEventSource] Connection error (attempt ${attempt})`);
          console.info(`[useEventSource] Reconnecting in ${delay}ms`);
        }
      },
    });

    return () => {
      mounted = false;
      if (debug) console.log('[useEventSource] Closing connection');
      handle.dispose();
    };
  }, [url, errorEventName, debug]);

  return { isConnected, error };
}

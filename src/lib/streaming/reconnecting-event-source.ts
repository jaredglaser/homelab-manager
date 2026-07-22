const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 16_000;

export interface ReconnectingEventSourceOptions {
  url: string;
  /** Fired when the underlying EventSource connects (initial connect or any later reconnect). */
  onOpen: () => void;
  /** Fired for every default (unnamed) SSE message. */
  onMessage: (event: { data: string }) => void;
  /**
   * Fired on every connection-level failure, before any retry/give-up decision is made.
   * Return `false` to tell the primitive not to schedule a retry for this failure (and,
   * since the flag that triggers this is typically permanent, for any failure after it) -
   * used by the log stream to stop reconnecting once the agent has signalled a clean
   * stream end.
   */
  onError: (event: Event) => void | false;
  /**
   * Named SSE event types (beyond the default 'message') to subscribe to and forward
   * through `onNamedEvent`. Includes the literal string 'error' when a caller needs to
   * inspect a server-sent named error payload distinct from a native connection failure:
   * EventSource dispatches both a property-based `onerror` and any `addEventListener('error', ...)`
   * handler for the same event, so the two don't interfere.
   */
  namedEvents?: string[];
  onNamedEvent?: (name: string, event: Event) => void;
  /**
   * Reconnect attempts allowed before giving up entirely (no further timers scheduled).
   * Undefined retries indefinitely: some streams must recover on their own once a
   * continuously visible tab's server comes back (#261).
   */
  maxAttempts?: number;
  /** Fired once, the attempt after `maxAttempts` is exceeded, when retries stop for good. */
  onGiveUp?: () => void;
  /** Fired on every failed attempt once this many consecutive failures have occurred, without affecting retry scheduling. */
  errorThreshold?: number;
  onErrorThreshold?: () => void;
  /** Reconnect immediately when the tab becomes visible again, if currently disconnected and idle. */
  reconnectOnVisibility?: boolean;
  /** Reconnect immediately (skipping remaining backoff) when the browser reports it is back online. */
  reconnectOnOnline?: boolean;
  /** Debug hook: fired right before each `new EventSource(url)` call, including retries. */
  onConnecting?: () => void;
  /** Debug hook: fired whenever a retry is scheduled, with the 1-based attempt count and delay. */
  onScheduleRetry?: (attempt: number, delayMs: number) => void;
}

export interface ReconnectingEventSourceHandle {
  /** Tear down the connection, cancel any pending retry, and remove all listeners. */
  dispose: () => void;
}

/**
 * Owns the reconnect lifecycle for a single browser EventSource: construction, exponential
 * backoff, indefinite or capped retry, visibility/online re-triggers, and named-event
 * forwarding. Has no opinion on message parsing or fan-out: callers own that through the
 * provided callbacks, which is what lets both a single-subscriber React hook and a
 * multi-subscriber registry sit on top of the same primitive.
 */
export function createReconnectingEventSource(
  options: ReconnectingEventSourceOptions,
): ReconnectingEventSourceHandle {
  const {
    url,
    onOpen,
    onMessage,
    onError,
    namedEvents = [],
    onNamedEvent,
    maxAttempts,
    onGiveUp,
    errorThreshold,
    onErrorThreshold,
    reconnectOnVisibility = false,
    reconnectOnOnline = false,
    onConnecting,
    onScheduleRetry,
  } = options;

  let disposed = false;
  let current: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;

  const connect = (): void => {
    if (disposed) return;

    onConnecting?.();
    const eventSource = new EventSource(url);
    current = eventSource;

    eventSource.onopen = () => {
      if (disposed || eventSource !== current) return;
      attempts = 0;
      onOpen();
    };

    eventSource.onmessage = (event) => {
      if (disposed || eventSource !== current) return;
      onMessage(event);
    };

    for (const name of namedEvents) {
      eventSource.addEventListener(name, (event) => {
        if (disposed || eventSource !== current) return;
        onNamedEvent?.(name, event);
      });
    }

    eventSource.onerror = (event) => {
      if (disposed || eventSource !== current) return;

      eventSource.close();
      current = null;

      const shouldStop = onError(event) === false;
      if (shouldStop) return;

      attempts++;

      if (maxAttempts !== undefined && attempts > maxAttempts) {
        onGiveUp?.();
        return;
      }

      if (errorThreshold !== undefined && attempts > errorThreshold) {
        onErrorThreshold?.();
      }

      const delay = Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
      onScheduleRetry?.(attempts, delay);

      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };
  };

  connect();

  const handleVisibilityChange = () => {
    if (document.visibilityState !== 'visible') return;
    if (current === null && reconnectTimer === null) {
      attempts = 0;
      connect();
    }
  };

  // Network came back: skip the remaining backoff delay and reconnect now with a
  // fresh retry budget instead of waiting out a stale timer.
  const handleOnline = () => {
    if (current !== null) return;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    attempts = 0;
    connect();
  };

  if (reconnectOnVisibility) document.addEventListener('visibilitychange', handleVisibilityChange);
  if (reconnectOnOnline) window.addEventListener('online', handleOnline);

  return {
    dispose: () => {
      disposed = true;
      if (reconnectOnVisibility) document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (reconnectOnOnline) window.removeEventListener('online', handleOnline);
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (current) {
        current.close();
        current = null;
      }
    },
  };
}

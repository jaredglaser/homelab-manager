const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 16_000;

export interface ReconnectingEventSourceOptions {
  url: string;
  onOpen: () => void;
  onMessage: (event: { data: string }) => void;
  /** Return `false` to stop retrying (e.g. after a clean stream end). */
  onError: (event: Event) => void | false;
  /** 'error' is valid here too: EventSource fires onerror and a named 'error' listener independently. */
  namedEvents?: string[];
  onNamedEvent?: (name: string, event: Event) => void;
  /** Undefined retries forever: a visible tab must recover once the server is back, however long that takes. */
  maxAttempts?: number;
  onGiveUp?: () => void;
  /** Unlike maxAttempts, crossing this doesn't stop retries; it only fires onErrorThreshold. */
  errorThreshold?: number;
  onErrorThreshold?: () => void;
  reconnectOnVisibility?: boolean;
  reconnectOnOnline?: boolean;
  onConnecting?: () => void;
  onScheduleRetry?: (attempt: number, delayMs: number) => void;
}

export interface ReconnectingEventSourceHandle {
  dispose: () => void;
}

/** Reconnect lifecycle for one EventSource; message parsing and fan-out stay with the caller. */
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

  // Skip the remaining backoff on 'online': reconnect now with a fresh retry budget.
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

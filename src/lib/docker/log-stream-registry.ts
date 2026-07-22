import { apiUrl } from '@/lib/utils/api-url';
import { createReconnectingEventSource, type ReconnectingEventSourceHandle } from '@/lib/streaming/reconnecting-event-source';

const MAX_RECONNECT_ATTEMPTS = 5;
// Matches xterm scrollback (2000 lines): a late-joining subscriber gets
// the same view that the terminal can display.
const BUFFER_MAX_LINES = 2_000;

export interface LogLine {
  text: string;
  stream: string;
}

export interface LogStreamSubscriber {
  onLine: (line: LogLine) => void;
  onConnect: () => void;
  /** Called when the connection drops. `cleanEnd` is true when the agent sent a stream_end event (container stopped normally). */
  onDisconnect: (cleanEnd: boolean) => void;
  onError: (error: Error) => void;
  onClear: () => void;
}

export interface SubscribeOptions {
  host: string;
  containerId: string;
  subscriber: LogStreamSubscriber;
}

class LogStream {
  private readonly subscribers = new Set<LogStreamSubscriber>();
  private buffer: LogLine[] = [];
  private handle: ReconnectingEventSourceHandle;
  private streamEnded = false;
  private hasConnected = false;
  private connected = false;
  private error: Error | null = null;

  constructor(private readonly url: string) {
    this.handle = this.connect();
  }

  subscribe(subscriber: LogStreamSubscriber): () => void {
    this.subscribers.add(subscriber);

    // Replay buffered lines and current state so a late joiner sees what
    // earlier subscribers already received.
    for (const line of this.buffer) subscriber.onLine(line);
    if (this.connected) subscriber.onConnect();
    if (this.error) subscriber.onError(this.error);

    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  hasSubscribers(): boolean {
    return this.subscribers.size > 0;
  }

  dispose(): void {
    this.handle.dispose();
    this.subscribers.clear();
    this.buffer = [];
  }

  private connect(): ReconnectingEventSourceHandle {
    return createReconnectingEventSource({
      url: this.url,
      maxAttempts: MAX_RECONNECT_ATTEMPTS,
      // Named events must have listeners or they fall through to onmessage.
      // 'error' carries the agent's own named error payload alongside the
      // native connection-failure error handled separately below.
      namedEvents: ['backlog_done', 'stream_end', 'error'],

      onOpen: () => {
        this.connected = true;
        this.error = null;

        // On reconnect the agent re-sends the backlog; drop the buffer and ask
        // subscribers to clear their terminals so the replay doesn't duplicate.
        if (this.hasConnected) {
          this.buffer = [];
          for (const sub of this.subscribers) sub.onClear();
        }
        this.hasConnected = true;

        for (const sub of this.subscribers) sub.onConnect();
      },

      onMessage: (event) => {
        try {
          const data = JSON.parse(event.data) as
            | { lines: LogLine[] }
            | LogLine;
          const lines = 'lines' in data ? data.lines : [data];
          for (const line of lines) this.appendLine(line);
        } catch (err) {
          console.error('[log-stream-registry] Failed to parse message:', err instanceof Error ? err.message : String(err), `payloadLength=${String(event.data ?? '').length}`);
        }
      },

      onNamedEvent: (name, event) => {
        if (name === 'stream_end') {
          // Agent signals the live follow stream ended cleanly (container stopped);
          // suppress the reconnect loop since no more logs are coming.
          this.streamEnded = true;
          return;
        }
        if (name === 'error') {
          // Agent-emitted named error: carries a JSON data payload describing the failure.
          const rawData = (event as unknown as Record<string, unknown>).data;
          if (typeof rawData !== 'string' || !rawData) return;
          try {
            const data = JSON.parse(rawData) as { message?: string; error?: string };
            const msg = data.message ?? data.error ?? 'Log stream error';
            this.appendLine({ text: `\x1b[31m[Error] ${msg}\x1b[0m`, stream: 'stderr' });
          } catch {
            this.appendLine({ text: '\x1b[31m[Error] Log stream error\x1b[0m', stream: 'stderr' });
          }
        }
        // 'backlog_done' needs no handling; the listener just exists so the
        // event doesn't fall through to onmessage.
      },

      onError: () => {
        this.connected = false;
        for (const sub of this.subscribers) sub.onDisconnect(this.streamEnded);
        if (this.streamEnded) return false;
      },

      onGiveUp: () => {
        const err = new Error('Log stream disconnected after multiple reconnect attempts. Check that the agent for this host is running and the container still exists.');
        this.error = err;
        for (const sub of this.subscribers) sub.onError(err);
      },
    });
  }

  private appendLine(line: LogLine): void {
    this.buffer.push(line);
    if (this.buffer.length > BUFFER_MAX_LINES) this.buffer.shift();
    for (const sub of this.subscribers) sub.onLine(line);
  }
}

const streams = new Map<string, LogStream>();

/**
 * Subscribe to a container's log stream. Subscribers sharing a (host, containerId)
 * key reuse a single EventSource: the first subscriber starts the stream, late
 * joiners get the buffered backlog replayed, and the stream tears down when the
 * last subscriber unsubscribes.
 *
 * Without this, two ContainerLogViewer instances (e.g. the row's recent-logs
 * panel and the modal viewing the same container) would open duplicate
 * EventSources to the same URL, which can stall under per-origin HTTP/1.1
 * connection limits.
 */
export function subscribeToContainerLogs({ host, containerId, subscriber }: SubscribeOptions): () => void {
  const key = `${host}/${containerId}`;
  let stream = streams.get(key);
  if (!stream) {
    const url = apiUrl(`/api/docker-logs/${encodeURIComponent(containerId)}?host=${encodeURIComponent(host)}`);
    stream = new LogStream(url);
    streams.set(key, stream);
  }
  const unsubscribe = stream.subscribe(subscriber);

  return () => {
    unsubscribe();
    const s = streams.get(key);
    if (s && !s.hasSubscribers()) {
      s.dispose();
      streams.delete(key);
    }
  };
}

/** Test-only: dispose all active streams and reset module state between tests. */
export function _resetLogStreams(): void {
  for (const s of streams.values()) s.dispose();
  streams.clear();
}

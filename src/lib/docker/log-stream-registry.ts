import { apiUrl } from '@/lib/utils/api-url';
import { createReconnectingEventSource, type ReconnectingEventSourceHandle } from '@/lib/streaming/reconnecting-event-source';

const MAX_RECONNECT_ATTEMPTS = 5;
// Matches xterm scrollback: a late-joining subscriber sees what the terminal can display.
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

    // Replay backlog and current state to the late joiner.
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
      // 'error' carries the agent's own named payload, separate from the connection-failure onError below.
      namedEvents: ['backlog_done', 'stream_end', 'error'],

      onOpen: () => {
        this.connected = true;
        this.error = null;

        // Agent re-sends the backlog on reconnect; clear ours first so the replay doesn't duplicate.
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
          // Container stopped normally; stop reconnecting since no more logs are coming.
          this.streamEnded = true;
          return;
        }
        if (name === 'error') {
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

/** Subscribers sharing a (host, containerId) share one EventSource, avoiding per-origin HTTP/1.1 connection limits. */
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

import { apiUrl } from '@/lib/utils/api-url';
import { createReconnectingEventSource, type ReconnectingEventSourceHandle } from '@/lib/streaming/reconnecting-event-source';

const MAX_RECONNECT_ATTEMPTS = 5;
// Matches xterm scrollback: a late-joining subscriber sees what the terminal can display.
const BUFFER_MAX_LINES = 2_000;
// Mirrors the server-side cap in log-mux-service. Checked client-side so the
// 21st row gets an immediate terminal error instead of a silent HTTP 400.
const MAX_MUX_STREAMS = 20;

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

/**
 * One container's shared state: backlog buffer plus subscribers. Transport is
 * the module-level mux connection below, so a stream never owns an
 * EventSource.
 */
class LogStream {
  private readonly subscribers = new Set<LogStreamSubscriber>();
  private buffer: LogLine[] = [];
  private connected = false;
  private hasConnected = false;
  private streamEnded = false;
  private error: Error | null = null;

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

  appendLines(lines: LogLine[]): void {
    for (const line of lines) {
      this.buffer.push(line);
      if (this.buffer.length > BUFFER_MAX_LINES) this.buffer.shift();
      for (const sub of this.subscribers) sub.onLine(line);
    }
  }

  /** Agent-reported stream error (e.g. container gone): surfaces as a red terminal line. */
  agentError(message: string): void {
    this.appendLines([{ text: `\x1b[31m[Error] ${message}\x1b[0m`, stream: 'stderr' }]);
  }

  /** A fresh upstream opened for this key: the agent is about to replay its backlog. */
  markBacklogStart(): void {
    if (this.hasConnected) {
      this.buffer = [];
      for (const sub of this.subscribers) sub.onClear();
    }
    this.hasConnected = true;
    this.connected = true;
    this.error = null;
    this.streamEnded = false;
    for (const sub of this.subscribers) sub.onConnect();
  }

  /** Container stopped normally. The agent closed this key's upstream. */
  markStreamEnded(): void {
    this.streamEnded = true;
    this.connected = false;
    for (const sub of this.subscribers) sub.onDisconnect(true);
  }

  markDisconnected(): void {
    // A clean stream end already notified subscribers. A mux-level error after
    // it carries no new information for this container.
    if (this.streamEnded) return;
    this.connected = false;
    for (const sub of this.subscribers) sub.onDisconnect(false);
  }

  fail(error: Error): void {
    this.error = error;
    for (const sub of this.subscribers) sub.onError(error);
  }
}

const streams = new Map<string, LogStream>();
let muxHandle: ReconnectingEventSourceHandle | null = null;
let sessionId: string | null = null;
/** True once the mux EventSource has opened; commands before that are pointless because onOpen re-POSTs the full key set. */
let muxOpened = false;

function newSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `s-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

async function postCommand(subscribe: string[], unsubscribe: string[]): Promise<void> {
  if (!sessionId) return;
  try {
    const response = await fetch(apiUrl('/api/docker-logs-mux'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: sessionId, subscribe, unsubscribe }),
    });
    if (!response.ok) {
      console.error(`[log-stream-registry] Mux command failed: HTTP ${response.status}`);
    }
  } catch (err) {
    console.error('[log-stream-registry] Mux command failed:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Opens the single mux EventSource for the whole app, once. It stays open
 * across subscribe/unsubscribe; which containers are delivered is driven by
 * POST commands, so expanding or collapsing a row never reopens the
 * connection or disturbs the other rows' terminals.
 */
function ensureMux(): void {
  if (muxHandle) return;
  sessionId = newSessionId();
  muxOpened = false;

  muxHandle = createReconnectingEventSource({
    url: apiUrl(`/api/docker-logs-mux?session=${sessionId}`),
    namedEvents: ['backlog_start', 'backlog_done', 'stream_end', 'error'],

    onOpen: () => {
      muxOpened = true;
      // Full resync: the server may have restarted since the last command, and
      // subscribing an already-active key makes the server reopen its upstream
      // and replay the backlog, so this is self-healing.
      void postCommand([...streams.keys()], []);
    },

    onMessage: (event) => {
      try {
        const data = JSON.parse(event.data) as { key: string; line?: LogLine; lines?: LogLine[] };
        const stream = streams.get(data.key);
        if (!stream) return;
        if (data.line) stream.appendLines([data.line]);
        else if (data.lines) stream.appendLines(data.lines);
      } catch (err) {
        console.error('[log-stream-registry] Failed to parse message:', err instanceof Error ? err.message : String(err), `payloadLength=${String(event.data ?? '').length}`);
      }
    },

    onNamedEvent: (name, event) => {
      let key: string | undefined;
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse((event as unknown as Record<string, unknown>).data as string) as Record<string, unknown>;
        key = typeof payload.key === 'string' ? payload.key : undefined;
      } catch {
        return;
      }
      if (!key) return;
      const stream = streams.get(key);
      if (!stream) return;

      if (name === 'backlog_start') {
        stream.markBacklogStart();
      } else if (name === 'stream_end') {
        stream.markStreamEnded();
      } else if (name === 'error') {
        const msg = typeof payload.message === 'string' && payload.message
          ? payload.message
          : typeof payload.error === 'string' && payload.error
            ? payload.error
            : 'Log stream error';
        stream.agentError(msg);
      }
      // backlog_done needs no client action. The backlog frames already arrived.
    },

    onError: () => {
      muxOpened = false;
      // Never stop retrying at mux level: a stream_end for one container must
      // not kill the shared connection the other containers still need.
      for (const stream of streams.values()) stream.markDisconnected();
    },

    maxAttempts: MAX_RECONNECT_ATTEMPTS,
    onGiveUp: () => {
      const err = new Error('Log stream disconnected after multiple reconnect attempts. Check that the agent for this host is running and the container still exists.');
      for (const stream of streams.values()) stream.fail(err);
    },
  });
}

/** Subscribers sharing a (host, containerId) share one stream, and all streams share one EventSource, staying under the browser's per-origin HTTP/1.1 connection cap. */
export function subscribeToContainerLogs({ host, containerId, subscriber }: SubscribeOptions): () => void {
  const key = `${host}/${containerId}`;
  let stream = streams.get(key);
  if (!stream) {
    if (streams.size >= MAX_MUX_STREAMS) {
      subscriber.onError(new Error(`Too many rows with open log streams (max ${MAX_MUX_STREAMS}). Collapse some rows first.`));
      return () => {};
    }
    stream = new LogStream();
    streams.set(key, stream);

    const created = muxHandle === null;
    ensureMux();
    // A just-created connection re-POSTs the full key set on open; before that
    // first open there is no server session to command, so skip the POST.
    if (!created && muxOpened) void postCommand([key], []);
  }
  const unsubscribe = stream.subscribe(subscriber);

  return () => {
    unsubscribe();
    const s = streams.get(key);
    if (s && !s.hasSubscribers()) {
      streams.delete(key);
      if (streams.size === 0) {
        muxHandle?.dispose();
        muxHandle = null;
        sessionId = null;
        muxOpened = false;
      } else if (muxOpened) {
        void postCommand([], [key]);
      }
    }
  };
}

/** Test-only: dispose the mux connection and reset module state between tests. */
export function _resetLogStreams(): void {
  muxHandle?.dispose();
  muxHandle = null;
  sessionId = null;
  muxOpened = false;
  streams.clear();
}

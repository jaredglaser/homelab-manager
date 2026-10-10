import { muxConnection, type MuxStatus, type MuxSubscribeError } from '@/lib/mux/mux-connection';
import { logsTopic, type MuxTopicFrame } from '@/lib/mux/protocol';

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

type LogPayload = { lines: LogLine[] } | LogLine;

class LogStream {
  private readonly subscribers = new Set<LogStreamSubscriber>();
  private buffer: LogLine[] = [];
  private streamEnded = false;
  private connected = false;
  private error: Error | null = null;
  private readonly unsubscribe: () => void;

  constructor(topic: string) {
    this.unsubscribe = muxConnection.subscribe(topic, {
      onEvent: (frame) => this.handleFrame(frame),
      onStatus: (status) => this.handleStatus(status),
      onSubscribeRejected: (error) => this.handleSubscribeRejected(error),
    });
  }

  subscribe(subscriber: LogStreamSubscriber): () => void {
    this.subscribers.add(subscriber);

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
    this.unsubscribe();
    this.subscribers.clear();
    this.buffer = [];
  }

  private handleFrame(frame: MuxTopicFrame): void {
    if (frame.kind === 'backlog_start') {
      this.buffer = [];
      for (const sub of this.subscribers) sub.onClear();
      return;
    }
    if (frame.kind === 'stream_end') {
      this.streamEnded = true;
      for (const sub of this.subscribers) sub.onDisconnect(true);
      return;
    }
    if (frame.kind === 'error') {
      const payload = frame.payload as { message?: string; gone?: boolean } | null;
      const msg = payload?.message ?? 'Log stream error';
      this.appendLine({ text: `\x1b[31m[Error] ${msg}\x1b[0m`, stream: 'stderr' });
      if (payload?.gone) {
        this.error = new Error(msg);
        for (const sub of this.subscribers) sub.onError(this.error);
      }
      return;
    }
    if (frame.kind !== 'data') return;
    try {
      const data = frame.payload as LogPayload | null;
      const lines = data && 'lines' in data ? data.lines : data ? [data as LogLine] : [];
      for (const line of lines) this.appendLine(line);
    } catch (err) {
      console.error('[log-stream-registry] Failed to handle frame:', err instanceof Error ? err.message : String(err));
    }
  }

  private handleStatus(status: MuxStatus): void {
    this.connected = status.connected;
    if (status.connected) {
      this.error = null;
      for (const sub of this.subscribers) sub.onConnect();
      return;
    }
    if (this.streamEnded) return;
    for (const sub of this.subscribers) sub.onDisconnect(false);
  }

  private handleSubscribeRejected(error: MuxSubscribeError): void {
    this.error = new Error(error.message);
    for (const sub of this.subscribers) sub.onError(this.error);
  }

  private appendLine(line: LogLine): void {
    this.buffer.push(line);
    if (this.buffer.length > BUFFER_MAX_LINES) this.buffer.shift();
    for (const sub of this.subscribers) sub.onLine(line);
  }
}

const streams = new Map<string, LogStream>();

/** Subscribers sharing a (host, containerId) share one mux topic on the app-wide connection. */
export function subscribeToContainerLogs({ host, containerId, subscriber }: SubscribeOptions): () => void {
  const key = `${host}/${containerId}`;
  let stream = streams.get(key);
  if (!stream) {
    stream = new LogStream(logsTopic(host, containerId));
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

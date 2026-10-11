import { toast } from 'sonner';
import { apiUrl } from '@/lib/utils/api-url';
import { MAX_SUB_BATCH, MAX_UNSUB_BATCH, type MuxAckFrame, type MuxTopicFrame, type MuxServerFrame } from '@/lib/mux/protocol';

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 16_000;
// Matches useEventSource: crossing this surfaces an error while retries continue forever.
const ERROR_AFTER_ATTEMPTS = 5;

export interface MuxSubscribeError {
  topic: string;
  code?: string;
  message: string;
}

export interface MuxTopicHandlers {
  onEvent: (frame: MuxTopicFrame) => void;
  onStatus?: (status: MuxStatus) => void;
  /** A toast already fires once per rejected ack. Use this only for per-view error state. */
  onSubscribeRejected?: (error: MuxSubscribeError) => void;
}

export interface MuxStatus {
  connected: boolean;
  error: Error | null;
}

export interface MuxConnectionDeps {
  createSocket: (url: string) => WebSocket;
}

function defaultCreateSocket(url: string): WebSocket {
  const wsScheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(`${wsScheme}//${window.location.host}${url}`);
}

function rejectionMessage({ code, error }: { code?: string; error?: string }): string {
  if (error) return error;
  if (code === 'topic_limit') return 'Session topic limit reached. Unsubscribe unused topics.';
  if (code) return `Subscription rejected (${code})`;
  return 'Subscription rejected';
}

type TopicEntry = {
  handlers: Set<MuxTopicHandlers>;
};

/**
 * One WebSocket carrying every live topic with runtime subscribe/unsubscribe
 * commands. Topics are ref-counted; on reconnect the full active set is
 * re-subscribed so the server re-sends per-topic initial state.
 */
export class MuxConnection {
  private readonly topics = new Map<string, TopicEntry>();
  private readonly pendingSubs = new Map<number, string[]>();
  private readonly statusListeners = new Set<(status: MuxStatus) => void>();
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private refCounter = 0;
  private disposed = false;
  private everConnected = false;
  private status: MuxStatus = { connected: false, error: null };

  constructor(
    private readonly path: string = apiUrl('/api/mux'),
    private readonly deps: MuxConnectionDeps = { createSocket: defaultCreateSocket },
  ) {}

  subscribe(topic: string, handlers: MuxTopicHandlers): () => void {
    let entry = this.topics.get(topic);
    const isFirst = !entry;
    if (!entry) {
      entry = { handlers: new Set() };
      this.topics.set(topic, entry);
    }
    entry.handlers.add(handlers);

    if (isFirst) {
      if (this.socket === null) {
        this.connect();
      } else if (this.socket.readyState === WebSocket.OPEN) {
        this.sendCommand('sub', [topic]);
      }
    }
    handlers.onStatus?.(this.status);

    return () => {
      const current = this.topics.get(topic);
      if (!current) return;
      current.handlers.delete(handlers);
      if (current.handlers.size === 0) {
        this.topics.delete(topic);
        if (this.socket?.readyState === WebSocket.OPEN) {
          this.sendCommand('unsub', [topic]);
        }
        if (this.topics.size === 0) this.teardownSocket();
      }
    };
  }

  subscribeStatus(listener: (status: MuxStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private setStatus(next: MuxStatus): void {
    this.status = next;
    for (const listener of this.statusListeners) listener(next);
    for (const entry of this.topics.values()) {
      for (const handlers of entry.handlers) handlers.onStatus?.(next);
    }
  }

  private sendCommand(type: 'sub' | 'unsub', topics: string[]): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    // The server rejects frames over its per-frame batch limit, so bursts split here.
    const maxBatch = type === 'sub' ? MAX_SUB_BATCH : MAX_UNSUB_BATCH;
    for (let i = 0; i < topics.length; i += maxBatch) {
      const chunk = topics.slice(i, i + maxBatch);
      const ref = this.refCounter++;
      if (type === 'sub') this.pendingSubs.set(ref, chunk);
      this.socket.send(JSON.stringify({ type, ref, topics: chunk }));
    }
  }

  private handleSubscribeRejected(ack: MuxAckFrame & { code?: unknown }, topics: string[] | undefined): void {
    const code = typeof ack.code === 'string' ? ack.code : undefined;
    const message = rejectionMessage({ code, error: ack.error });
    console.error('[mux-connection] Subscription rejected:', ack.error ?? '(no detail)', `ref=${ack.ref}`);
    toast.error(message);
    for (const topic of topics ?? []) {
      const entry = this.topics.get(topic);
      if (!entry) continue;
      for (const handlers of entry.handlers) handlers.onSubscribeRejected?.({ topic, code, message });
    }
  }

  private connect(): void {
    if (this.disposed || this.socket !== null) return;
    const socket = this.deps.createSocket(this.path);
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempts = 0;
      this.everConnected = true;
      this.setStatus({ connected: true, error: null });
      this.pendingSubs.clear();
      if (this.topics.size > 0) {
        this.sendCommand('sub', [...this.topics.keys()]);
      }
    };

    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      let frame: MuxServerFrame;
      try {
        frame = JSON.parse(String(event.data)) as MuxServerFrame;
      } catch (err) {
        console.error('[mux-connection] Failed to parse frame:', err instanceof Error ? err.message : String(err));
        return;
      }
      if (frame.type === 'event') {
        const entry = this.topics.get(frame.topic);
        if (!entry) return;
        for (const handlers of entry.handlers) handlers.onEvent(frame);
        return;
      }
      if (frame.type === 'ack') {
        const topics = this.pendingSubs.get(frame.ref);
        this.pendingSubs.delete(frame.ref);
        if (!frame.ok) this.handleSubscribeRejected(frame, topics);
      }
    };

    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.setStatus({ connected: false, error: null });
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose always follows onerror; backoff is scheduled there.
    };
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null || this.topics.size === 0) return;
    this.attempts++;
    if (this.attempts > ERROR_AFTER_ATTEMPTS) {
      this.setStatus({
        connected: false,
        error: new Error('Connection failed after multiple attempts'),
      });
    }
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** (this.attempts - 1), MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    window.addEventListener('online', this.handleOnline);
  }

  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') return;
    if (this.socket === null && this.reconnectTimer !== null) {
      this.clearReconnectTimer();
      this.attempts = 0;
      this.connect();
    }
  };

  private readonly handleOnline = (): void => {
    if (this.socket !== null) return;
    if (this.reconnectTimer !== null) {
      this.clearReconnectTimer();
      this.attempts = 0;
      this.connect();
    }
  };

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    window.removeEventListener('online', this.handleOnline);
  }

  private teardownSocket(): void {
    this.clearReconnectTimer();
    this.pendingSubs.clear();
    this.attempts = 0;
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
        // already closed
      }
    }
    if (this.everConnected) {
      this.setStatus({ connected: false, error: null });
    }
    this.everConnected = false;
  }

  /** Test-only: drop all topics and sockets and reset module state between tests. */
  _reset(): void {
    this.disposed = true;
    this.teardownSocket();
    this.topics.clear();
    this.statusListeners.clear();
    this.disposed = false;
    this.status = { connected: false, error: null };
  }
}

export const muxConnection = new MuxConnection();

import type { MuxSubscribeError, MuxTopicHandlers, MuxStatus } from '@/lib/mux/mux-connection';
import type { MuxEventFrame, MuxEventKind } from '@/lib/mux/protocol';

export class FakeMuxConnection {
  readonly subscriptions = new Map<string, Set<MuxTopicHandlers>>();
  status: MuxStatus = { connected: false, error: null };

  subscribe(topic: string, handlers: MuxTopicHandlers): () => void {
    let set = this.subscriptions.get(topic);
    if (!set) {
      set = new Set();
      this.subscriptions.set(topic, set);
    }
    set.add(handlers);
    handlers.onStatus?.(this.status);
    return () => {
      set.delete(handlers);
      if (set.size === 0) this.subscriptions.delete(topic);
    };
  }

  subscribedTopics(): string[] {
    return [...this.subscriptions.keys()];
  }

  subscriptionCount(topic: string): number {
    return this.subscriptions.get(topic)?.size ?? 0;
  }

  emit(topic: string, kind: MuxEventKind, payload: unknown = {}): void {
    const set = this.subscriptions.get(topic);
    if (!set) return;
    const frame: MuxEventFrame = { type: 'event', topic, kind, payload };
    for (const handlers of set) handlers.onEvent(frame);
  }

  /** Simulates a wire payload: JSON round-trip turns Dates into ISO strings like a real frame. */
  emitWire(topic: string, kind: MuxEventKind, payload: unknown): void {
    this.emit(topic, kind, JSON.parse(JSON.stringify(payload)));
  }

  setStatus(status: MuxStatus): void {
    this.status = status;
    for (const set of this.subscriptions.values()) {
      for (const handlers of set) handlers.onStatus?.(status);
    }
  }

  emitSubscribeRejected(topic: string, error: Pick<MuxSubscribeError, 'code' | 'message'>): void {
    const set = this.subscriptions.get(topic);
    if (!set) return;
    for (const handlers of set) handlers.onSubscribeRejected?.({ topic, ...error });
  }
}

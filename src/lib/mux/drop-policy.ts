import { lookupTopicSpec, type MuxFrameBody } from '@/lib/mux/protocol';

export interface MuxDropPolicyConfig {
  /** Unsented socket bytes at which bulk shedding starts. */
  highWaterBytes: number;
  /** Unsented socket bytes at which shedding stops. Keep strictly below highWaterBytes so one stalled socket cannot flap. */
  lowWaterBytes: number;
  /** Upper bound on how long a shed count or coalesced control frame waits before hitting the wire. */
  reportIntervalMs: number;
}

export const DEFAULT_MUX_DROP_POLICY: MuxDropPolicyConfig = {
  highWaterBytes: 1024 * 1024,
  lowWaterBytes: 256 * 1024,
  reportIntervalMs: 1000,
};

export type MuxPushResult = 'delivered' | 'coalesced' | 'shed' | 'failed';

export interface MuxWriteQueueDeps {
  send: (json: string) => void;
  /** Unsented socket bytes for this session, e.g. crossws `Peer.bufferedAmount`. */
  getBufferedBytes: () => number;
  config?: MuxDropPolicyConfig;
  onSendError?: (err: unknown, topic: string | null) => void;
}

/**
 * Per-session write gate for mux topic frames. Bulk data frames shed under
 * write-queue pressure and report as `dropped {topic, count}` frames, control
 * data frames coalesce to latest per topic, and heartbeats plus non-data frames
 * (backlog markers, errors, drop reports) always go straight out.
 */
export class MuxWriteQueue {
  private readonly config: MuxDropPolicyConfig;
  private readonly controlPending = new Map<string, MuxFrameBody>();
  private readonly droppedPending = new Map<string, number>();
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private pressured = false;

  constructor(private readonly deps: MuxWriteQueueDeps) {
    this.config = deps.config ?? DEFAULT_MUX_DROP_POLICY;
  }

  pushFrame(frame: MuxFrameBody): MuxPushResult {
    if (this.checkPressure()) {
      const spec = lookupTopicSpec(frame.topic);
      if (spec?.class === 'bulk' && frame.kind === 'data') {
        this.droppedPending.set(frame.topic, (this.droppedPending.get(frame.topic) ?? 0) + 1);
        this.ensureTick();
        return 'shed';
      }
      if (spec?.class === 'control' && frame.kind === 'data') {
        this.controlPending.set(frame.topic, frame);
        this.ensureTick();
        return 'coalesced';
      }
      return this.deliverFrame(frame, frame.topic);
    }
    this.flush();
    return this.deliverFrame(frame, frame.topic);
  }

  pushPing(): void {
    try {
      this.deps.send(JSON.stringify({ type: 'ping' }));
    } catch {
      // peer gone. The close handler tears the session down.
    }
  }

  clearTopic(topic: string): void {
    this.controlPending.delete(topic);
    this.droppedPending.delete(topic);
    if (this.controlPending.size === 0 && this.droppedPending.size === 0) this.clearTick();
  }

  dispose(): void {
    this.clearTick();
    this.controlPending.clear();
    this.droppedPending.clear();
  }

  private checkPressure(): boolean {
    const buffered = this.deps.getBufferedBytes();
    if (this.pressured) {
      if (buffered <= this.config.lowWaterBytes) this.pressured = false;
    } else if (buffered >= this.config.highWaterBytes) {
      this.pressured = true;
    }
    return this.pressured;
  }

  private flush(): void {
    this.clearTick();
    for (const [topic, count] of this.droppedPending) {
      this.deliverFrame({ topic, kind: 'dropped', count }, topic);
    }
    this.droppedPending.clear();
    for (const [topic, frame] of this.controlPending) {
      this.deliverFrame(frame, topic);
    }
    this.controlPending.clear();
  }

  private ensureTick(): void {
    if (this.tickTimer !== null) return;
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null;
      this.checkPressure();
      this.flush();
    }, this.config.reportIntervalMs);
  }

  private clearTick(): void {
    if (this.tickTimer !== null) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private deliverFrame(frame: MuxFrameBody, topic: string | null): MuxPushResult {
    return this.deliver(JSON.stringify({ type: 'event', ...frame }), topic) ? 'delivered' : 'failed';
  }

  private deliver(json: string, topic: string | null): boolean {
    try {
      this.deps.send(json);
      return true;
    } catch (err) {
      this.deps.onSendError?.(err, topic);
      return false;
    }
  }
}

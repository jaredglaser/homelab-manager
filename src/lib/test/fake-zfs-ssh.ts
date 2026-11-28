import { ZFS_INFLUXDB_COMMAND, ZFS_STATUS_COMMAND } from '@/lib/zfs/node-setup-script';
import {
  ZfsSshError,
  type ZfsExecResult,
  type ZfsSshConnectOptions,
  type ZfsSshSession,
  type ZfsSshStream,
  type ZfsSshTarget,
  type ZfsSshTransport,
  type ZfsTimer,
} from '@/lib/zfs/ssh-transport';

export const EMPTY_STATUS = '{"output_version":{"command":"zpool status","vers_major":0,"vers_minor":1},"pools":{}}';

/** A node as the fake transport presents it. Every field can change between connects. */
export interface FakeNodeBehaviour {
  fingerprint: string;
  /** Thrown from connect after the host key was accepted. */
  connectError: ZfsSshError | null;
  /** Connect never completes until the caller aborts. */
  connectHangs: boolean;
  status: ZfsExecResult | 'hang';
  /** Text printed for the nth newline written to zpool_influxdb (0-based), or null to print nothing. */
  influx: (request: number) => string | null;
  /** Exit status zpool_influxdb exits with as soon as it starts, or null to keep running. */
  influxExit: number | null;
  /** Whether the session still answers the liveness command. */
  responsive: boolean;
}

export class FakeStream implements ZfsSshStream {
  requests = 0;
  closed = false;
  private readonly dataListeners: ((chunk: string) => void)[] = [];
  private readonly closeListeners: ((code: number | null, stderr: string) => void)[] = [];

  constructor(private readonly behaviour: FakeNodeBehaviour) {}

  write(data: string): void {
    if (this.closed) return;
    for (const _newline of data.split('').filter((char) => char === '\n')) {
      const text = this.behaviour.influx(this.requests++);
      if (text !== null) this.emit(text);
    }
  }

  emit(text: string): void {
    for (const listener of this.dataListeners) listener(text);
  }

  onData(listener: (chunk: string) => void): void {
    this.dataListeners.push(listener);
  }

  private exitStatus: [number | null, string] = [null, ''];

  onClose(listener: (code: number | null, stderr: string) => void): void {
    if (this.closed) listener(...this.exitStatus);
    else this.closeListeners.push(listener);
  }

  exit(code: number | null, stderr = ''): void {
    if (this.closed) return;
    this.closed = true;
    this.exitStatus = [code, stderr];
    for (const listener of this.closeListeners) listener(code, stderr);
  }

  close(): void {
    this.exit(null);
  }
}

export class FakeSession implements ZfsSshSession {
  closed = false;
  streams: FakeStream[] = [];
  statusCalls = 0;
  private readonly closeListeners: (() => void)[] = [];
  private readonly hangingExecs: { resolve: (result: ZfsExecResult) => void; reject: (err: Error) => void }[] = [];
  livenessChecks = 0;

  constructor(private readonly behaviour: FakeNodeBehaviour) {}

  exec(command: string, _timeoutMs: number | null): Promise<ZfsExecResult> {
    if (command !== ZFS_STATUS_COMMAND) return Promise.resolve({ code: 126, stdout: '', stderr: 'refused' });
    this.statusCalls++;
    const status = this.behaviour.status;
    if (status === 'hang') {
      return new Promise((resolve, reject) => {
        this.hangingExecs.push({ resolve, reject });
      });
    }
    return Promise.resolve(status);
  }

  /** Lets every hung status read finish, as a pool that resumes would. */
  releaseStatus(result: ZfsExecResult): void {
    for (const exec of this.hangingExecs.splice(0)) exec.resolve(result);
  }

  get statusOutstanding(): number {
    return this.hangingExecs.length;
  }

  isResponsive(_timeoutMs: number): Promise<boolean> {
    this.livenessChecks++;
    return Promise.resolve(!this.closed && this.behaviour.responsive);
  }

  stream(command: string): Promise<ZfsSshStream> {
    if (command !== ZFS_INFLUXDB_COMMAND) return Promise.reject(new ZfsSshError('error', 'refused'));
    const stream = new FakeStream(this.behaviour);
    this.streams.push(stream);
    if (this.behaviour.influxExit !== null) {
      const code = this.behaviour.influxExit;
      queueMicrotask(() => stream.exit(code, 'zpool_influxdb is not installed on this node.\n'));
    }
    return Promise.resolve(stream);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const stream of this.streams) stream.close();
    for (const exec of this.hangingExecs.splice(0)) exec.reject(new ZfsSshError('error', 'session closed'));
    for (const listener of this.closeListeners) listener();
  }
}

export interface ConnectAttempt {
  target: ZfsSshTarget;
  options: ZfsSshConnectOptions;
}

export class FakeZfsTransport implements ZfsSshTransport {
  readonly attempts: ConnectAttempt[] = [];
  readonly sessions: FakeSession[] = [];
  behaviour: FakeNodeBehaviour;

  constructor(behaviour: Partial<FakeNodeBehaviour> = {}) {
    this.behaviour = {
      fingerprint: 'SHA256:node-key',
      connectError: null,
      connectHangs: false,
      status: { code: 0, stdout: EMPTY_STATUS, stderr: '' },
      influx: () => '',
      influxExit: null,
      responsive: true,
      ...behaviour,
    };
  }

  connect(target: ZfsSshTarget, options: ZfsSshConnectOptions): Promise<ZfsSshSession> {
    this.attempts.push({ target, options });
    const behaviour = this.behaviour;
    if (options.signal?.aborted) return Promise.reject(new ZfsSshError('error', 'Connection cancelled'));
    if (behaviour.connectHangs) {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new ZfsSshError('error', 'Connection cancelled')), { once: true });
      });
    }
    if (!options.acceptHostKey(behaviour.fingerprint)) {
      return Promise.reject(new ZfsSshError('host_key', 'The node presented a host key that is not confirmed', behaviour.fingerprint));
    }
    if (behaviour.connectError) return Promise.reject(behaviour.connectError);
    const session = new FakeSession(behaviour);
    this.sessions.push(session);
    return Promise.resolve(session);
  }
}

/** Stands in for the collector's one-second wait: each `step` releases one wait and moves the clock. */
export class ManualTicker {
  clock = 1_000_000;
  private waiter: (() => void) | null = null;

  readonly now = (): number => this.clock;

  readonly tick = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      this.waiter = () => {
        this.clock += ms;
        resolve();
      };
    });

  get waiting(): boolean {
    return this.waiter !== null;
  }

  release(): void {
    const waiter = this.waiter;
    if (!waiter) throw new Error('ManualTicker: nothing is waiting');
    this.waiter = null;
    waiter();
  }
}

/** A ZfsTimer that fires on the next microtask unless cancelled first. */
export const immediateTimer: ZfsTimer = (fn) => {
  let cancelled = false;
  queueMicrotask(() => {
    if (!cancelled) fn();
  });
  return () => {
    cancelled = true;
  };
};

/** A ZfsTimer whose timers fire only when the test calls `fireAll`. */
export class ManualTimer {
  private readonly pending = new Set<() => void>();

  readonly timer: ZfsTimer = (fn) => {
    this.pending.add(fn);
    return () => this.pending.delete(fn);
  };

  get count(): number {
    return this.pending.size;
  }

  fireAll(): void {
    const due = [...this.pending];
    this.pending.clear();
    for (const fn of due) fn();
  }
}

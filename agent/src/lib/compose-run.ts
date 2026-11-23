import type {
  ComposeAction,
  ComposeFrameEvent,
  ComposeLineFrame,
  ComposePhase,
  ComposeResultFrame,
} from '../types/protocol';

export type SpawnFn = typeof Bun.spawn;

export interface ProcessSpec {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export interface SpawnResult {
  /** Null only when the process never reported an exit after being killed. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  readError?: string;
  /** Output was lost: the runner stopped waiting for a pipe that never closed. */
  outputIncomplete?: true;
}

const noop = (): void => undefined;

export type OutputStreamName = 'stdout' | 'stderr';

export interface OutputSink {
  write(stream: OutputStreamName, chunk: Uint8Array<ArrayBuffer>): void;
  end(stream: OutputStreamName): void;
}

export const MAX_LINE_CHARS = 4096;
export const MAX_STREAMED_BYTES = 8 * 1024 * 1024;
export const RETAINED_LINES = 100;
export const RUN_RETENTION_MS = 10 * 60_000;
export const MAX_RETAINED_RUNS = 20;
export const FRAME_OVERHEAD_BYTES = 96;
export const TAIL_MAX_BYTES = 32 * 1024;
export const KILL_GRACE_MS = 5000;
export const DRAIN_GRACE_MS = 5000;
const YIELD_EVERY_BYTES = 256 * 1024;

export interface RunLimits {
  killGraceMs: number;
  drainGraceMs: number;
}

const DEFAULT_LIMITS: RunLimits = { killGraceMs: KILL_GRACE_MS, drainGraceMs: DRAIN_GRACE_MS };

export interface ProcessOutcome {
  exitCode: number | null;
  timedOut: boolean;
  readError?: string;
  outputIncomplete?: true;
}

/**
 * Spawns and drains both pipes into the sink. At the deadline, or when a pipe read fails, it sends SIGTERM,
 * then SIGKILL after `killGraceMs`, and stops waiting on a process or pipe `drainGraceMs` after that, so it always settles.
 * Rejects only when the spawn throws.
 */
export async function runProcess(
  spawn: SpawnFn,
  spec: ProcessSpec,
  timeoutMs: number,
  sink: OutputSink,
  limits: RunLimits = DEFAULT_LIMITS,
  context?: string,
): Promise<ProcessOutcome> {
  const where = context ? ` (${context})` : '';
  const proc = spawn({ cmd: spec.cmd, cwd: spec.cwd, stdout: 'pipe', stderr: 'pipe', env: spec.env });
  let timedOut = false;
  let readError: string | undefined;
  let terminating = false;
  let exited = false;
  let outputIncomplete = false;
  const state = { drained: false };
  const timers: ReturnType<typeof setTimeout>[] = [];
  const readers: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>[] = [];
  let giveUp!: () => void;
  const gaveUp = new Promise<null>((resolve) => { giveUp = () => resolve(null); });

  const kill = (signal?: number) => { proc.kill?.(signal); };
  const terminate = () => {
    if (terminating) return;
    terminating = true;
    kill();
    timers.push(setTimeout(() => {
      kill(9);
      timers.push(setTimeout(giveUp, limits.drainGraceMs));
    }, limits.killGraceMs));
  };

  const failRead = (name: OutputStreamName, error: unknown) => {
    readError ??= `Reading ${name} failed: ${describeError(error)}`;
    terminate();
  };

  const drain = async (stream: unknown, name: OutputStreamName): Promise<void> => {
    try {
      if (stream) {
        const reader = (stream as ReadableStream<Uint8Array<ArrayBuffer>>).getReader();
        readers.push(reader);
        let sinceYield = 0;
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
          sink.write(name, chunk.value);
          sinceYield += chunk.value.byteLength;
          if (sinceYield >= YIELD_EVERY_BYTES) {
            sinceYield = 0;
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        }
      }
    } catch (error) {
      failRead(name, error);
    }
    try {
      sink.end(name);
    } catch (error) {
      failRead(name, error);
    }
  };

  const deadline = setTimeout(() => {
    if (exited) return;
    timedOut = true;
    terminate();
  }, timeoutMs);
  timers.push(deadline);
  const drains = Promise.all([drain(proc.stdout, 'stdout'), drain(proc.stderr, 'stderr')]).then(() => { state.drained = true; });

  try {
    const exit = await Promise.race([
      proc.exited.then((code) => {
        exited = true;
        clearTimeout(deadline);
        return { code };
      }),
      gaveUp,
    ]);
    if (!exit) {
      console.error(`Gave up waiting for ${spec.cmd.join(' ')} (pid ${String(proc.pid)}) to exit after SIGKILL${where}`);
    }
    if (exit && !state.drained) {
      let stopWaiting!: () => void;
      const waited = new Promise<void>((resolve) => { stopWaiting = resolve; });
      timers.push(setTimeout(stopWaiting, limits.drainGraceMs));
      await Promise.race([drains, waited, gaveUp]);
    }
    if (!state.drained) {
      outputIncomplete = true;
      console.error(`Gave up waiting on output of ${spec.cmd.join(' ')}${where}`);
      for (const reader of readers) reader.cancel().catch(noop);
      await Promise.race([drains, Bun.sleep(limits.drainGraceMs)]);
    }
    return { exitCode: exit ? exit.code : null, timedOut, readError, ...(outputIncomplete ? { outputIncomplete: true as const } : {}) };
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
}

export class BufferedSink implements OutputSink {
  private readonly decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  private readonly parts: Record<OutputStreamName, string[]> = { stdout: [], stderr: [] };

  write(stream: OutputStreamName, chunk: Uint8Array<ArrayBuffer>): void {
    this.parts[stream].push(this.decoders[stream].decode(chunk, { stream: true }));
  }

  end(stream: OutputStreamName): void {
    this.parts[stream].push(this.decoders[stream].decode());
  }

  text(stream: OutputStreamName): string {
    return this.parts[stream].join('');
  }
}

export async function runBuffered(
  spawn: SpawnFn,
  spec: ProcessSpec,
  timeoutMs: number,
  limits?: RunLimits,
  context?: string,
): Promise<SpawnResult> {
  const sink = new BufferedSink();
  const { exitCode, timedOut, readError } = await runProcess(spawn, spec, timeoutMs, sink, limits, context);
  if (readError) throw new Error(readError);
  return { exitCode: exitCode ?? 137, stdout: sink.text('stdout'), stderr: sink.text('stderr'), timedOut };
}

type LineHandler = (text: string, truncated: boolean, overflowBytes: number) => void;

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;

class LineSplitter {
  private readonly decoder = new TextDecoder();
  private line = '';
  private truncated = false;
  private overflowBytes = 0;
  private skipLeadingLf = false;

  constructor(private readonly onLine: LineHandler) {}

  push(chunk: Uint8Array<ArrayBuffer>): void {
    this.feed(this.decoder.decode(chunk, { stream: true }));
  }

  end(): void {
    this.feed(this.decoder.decode());
    if (this.line.length > 0) this.emitLine();
    this.skipLeadingLf = false;
  }

  private feed(text: string): void {
    if (text.length === 0) return;
    let segmentStart = 0;
    if (this.skipLeadingLf) {
      this.skipLeadingLf = false;
      if (text.charCodeAt(0) === 10) segmentStart = 1;
    }
    for (let i = segmentStart; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code !== 10 && code !== 13) continue;
      this.append(text, segmentStart, i);
      this.emitLine();
      if (code === 13) {
        if (i + 1 === text.length) this.skipLeadingLf = true;
        else if (text.charCodeAt(i + 1) === 10) i++;
      }
      segmentStart = i + 1;
    }
    this.append(text, segmentStart, text.length);
  }

  private append(text: string, from: number, to: number): void {
    if (from >= to) return;
    const room = MAX_LINE_CHARS - this.line.length;
    if (room < to - from) {
      this.truncated = true;
      this.overflowBytes += Buffer.byteLength(text.slice(from + Math.max(room, 0), to));
    }
    if (room > 0) this.line += text.slice(from, from + Math.min(room, to - from));
  }

  private emitLine(): void {
    let text = this.line;
    const truncated = this.truncated;
    const overflowBytes = this.overflowBytes;
    this.line = '';
    this.truncated = false;
    this.overflowBytes = 0;
    if (truncated) {
      const last = text.charCodeAt(text.length - 1);
      if (last >= HIGH_SURROGATE_MIN && last <= HIGH_SURROGATE_MAX) text = text.slice(0, -1);
    }
    this.onLine(text, truncated, overflowBytes);
  }
}

export interface TailLine {
  stream: OutputStreamName;
  text: string;
  truncated?: true;
}

export class SseSink implements OutputSink {
  droppedLines = 0;
  droppedBytes = 0;
  readonly droppedTail: TailLine[] = [];
  private tailBytes = 0;
  private sentBytes = 0;
  private capped = false;
  private readonly splitters: Record<OutputStreamName, LineSplitter>;

  constructor(
    private readonly deliver: (stream: OutputStreamName, text: string, truncated: boolean) => void,
    private readonly maxBytes: number = MAX_STREAMED_BYTES,
  ) {
    this.splitters = {
      stdout: new LineSplitter((text, truncated, overflow) => this.line('stdout', text, truncated, overflow)),
      stderr: new LineSplitter((text, truncated, overflow) => this.line('stderr', text, truncated, overflow)),
    };
  }

  write(stream: OutputStreamName, chunk: Uint8Array<ArrayBuffer>): void {
    this.splitters[stream].push(chunk);
  }

  end(stream: OutputStreamName): void {
    this.splitters[stream].end();
  }

  private line(stream: OutputStreamName, text: string, truncated: boolean, overflowBytes: number): void {
    this.droppedBytes += overflowBytes;
    const cost = Buffer.byteLength(JSON.stringify(text)) + FRAME_OVERHEAD_BYTES;
    if (this.capped || this.sentBytes + cost > this.maxBytes) {
      this.capped = true;
      this.droppedLines++;
      this.droppedBytes += Buffer.byteLength(text);
      this.keepTail({ stream, text, ...(truncated ? { truncated: true as const } : {}) });
      return;
    }
    this.sentBytes += cost;
    this.deliver(stream, text, truncated);
  }

  private keepTail(entry: TailLine): void {
    this.droppedTail.push(entry);
    this.tailBytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
    // The array JSON is the entries plus count-1 commas plus two brackets, so the sum of (size + 1) is one short of its length.
    while (this.droppedTail.length > RETAINED_LINES || this.tailBytes + 1 > TAIL_MAX_BYTES) {
      const oldest = this.droppedTail.shift();
      if (!oldest) break;
      this.tailBytes -= Buffer.byteLength(JSON.stringify(oldest)) + 1;
    }
  }
}

export interface ComposeFlowIO {
  /** Set on a streamed run, so a log line from the flow can name it. */
  readonly runId?: string;
  phase(phase: ComposePhase, timeoutMs?: number): void;
  run(spec: ProcessSpec, timeoutMs: number): Promise<SpawnResult>;
  /** Runs a process whose output the flow reads itself and must never reach the log (`compose config` prints resolved secrets). */
  runQuiet(spec: ProcessSpec, timeoutMs: number): Promise<SpawnResult>;
}

export type ComposeFlowOutcome =
  | { kind: 'finished'; phase: ComposePhase; result: SpawnResult; timeoutMs: number }
  | { kind: 'spawn_failed'; phase: ComposePhase; error: unknown };

export type ComposeFlow = (io: ComposeFlowIO) => Promise<ComposeFlowOutcome>;

export function createBufferedIO(spawn: SpawnFn, context?: string): ComposeFlowIO {
  return {
    phase: noop,
    run: (spec, timeoutMs) => runBuffered(spawn, spec, timeoutMs, undefined, context),
    runQuiet: (spec, timeoutMs) => runBuffered(spawn, spec, timeoutMs, undefined, context),
  };
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const MAX_DETAIL_CHARS = 1000;

type Listener = (frame: ComposeFrameEvent) => void;

export class ComposeRun {
  readonly runId = crypto.randomUUID();
  finishedAt: number | null = null;
  private seq = 0;
  private lastPhase: ComposePhase | undefined;
  private resultFrame: ComposeResultFrame | undefined;
  private readonly listeners = new Set<Listener>();
  private readonly recentLines: ComposeLineFrame[] = [];
  private readonly sink = new SseSink((stream, text, truncated) => this.emitLine(stream, text, truncated));
  private resolveDone!: (frame: ComposeResultFrame) => void;
  readonly done = new Promise<ComposeResultFrame>((resolve) => { this.resolveDone = resolve; });

  constructor(
    readonly action: ComposeAction,
    readonly stack: string,
    private readonly now: () => number,
    private readonly onFinish: () => void,
    private readonly limits?: RunLimits,
  ) {}

  get result(): ComposeResultFrame | undefined {
    return this.resultFrame;
  }

  get lastLines(): readonly ComposeLineFrame[] {
    return this.recentLines;
  }

  /** Delivers frames emitted from now on. Unsubscribing never touches the process. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  start(flow: ComposeFlow, spawn: SpawnFn): void {
    this.execute(flow, spawn).catch((error: unknown) => {
      console.error(`Compose run ${this.runId} for ${this.stack} could not be finished:`, error);
    });
  }

  private async execute(flow: ComposeFlow, spawn: SpawnFn): Promise<void> {
    const io: ComposeFlowIO = {
      runId: this.runId,
      phase: (phase, timeoutMs) => this.emitPhase(phase, timeoutMs),
      run: async (spec, timeoutMs) => {
        const outcome = await runProcess(spawn, spec, timeoutMs, this.sink, this.limits, this.where());
        return { ...outcome, stdout: '', stderr: '' };
      },
      runQuiet: (spec, timeoutMs) => runBuffered(spawn, spec, timeoutMs, this.limits, this.where()),
    };

    let outcome: ComposeFlowOutcome | undefined;
    let unexpected: unknown;
    try {
      outcome = await flow(io);
    } catch (error) {
      console.error(`Compose run ${this.runId} for ${this.stack} failed unexpectedly:`, error);
      unexpected = error;
    }
    this.finish(outcome, unexpected);
  }

  private where(): string {
    return `run ${this.runId}, ${this.action} ${this.stack}, phase ${this.lastPhase ?? 'none'}`;
  }

  private finish(outcome: ComposeFlowOutcome | undefined, unexpected: unknown): void {
    let frame: ComposeResultFrame;
    let finishedAt: number;
    try {
      frame = this.buildResult(outcome, unexpected);
      finishedAt = this.now();
    } catch (error) {
      console.error(`Compose run ${this.runId} for ${this.stack} could not build its result:`, error);
      frame = {
        seq: this.seq + 1,
        status: 'failed',
        exitCode: null,
        timedOut: false,
        detail: `The agent could not build the result of this run: ${describeError(error)}`.slice(0, MAX_DETAIL_CHARS),
        droppedLines: this.sink.droppedLines,
        droppedBytes: this.sink.droppedBytes,
      };
      finishedAt = Date.now();
    }
    this.seq = frame.seq;
    this.resultFrame = frame;
    this.finishedAt = finishedAt;
    this.notify({ event: 'result', data: frame });
    try {
      this.onFinish();
    } catch (error) {
      console.error(`Compose run ${this.runId} for ${this.stack} could not prune finished runs:`, error);
    }
    this.resolveDone(frame);
  }

  private buildResult(outcome: ComposeFlowOutcome | undefined, unexpected: unknown): ComposeResultFrame {
    const counts = {
      droppedLines: this.sink.droppedLines,
      droppedBytes: this.sink.droppedBytes,
      ...(this.sink.droppedLines > 0 ? { tail: [...this.sink.droppedTail] } : {}),
    };
    const body = (() => {
      if (!outcome) {
        return this.spawnFailure(this.lastPhase, unexpected);
      }
      if (outcome.kind === 'spawn_failed') {
        return this.spawnFailure(outcome.phase, outcome.error);
      }
      const { result, phase, timeoutMs } = outcome;
      const detail = result.readError ? { detail: result.readError.slice(0, MAX_DETAIL_CHARS) } : {};
      const incomplete = result.outputIncomplete ? { outputIncomplete: true as const } : {};
      if (result.timedOut || result.exitCode !== 0 || result.readError) {
        console.error(
          `Compose run ${this.runId} (${this.action} ${this.stack}) failed in phase ${phase}: exit ${String(result.exitCode)}, timedOut ${String(result.timedOut)}${result.readError ? `, ${result.readError}` : ''}`,
        );
      }
      if (result.timedOut) {
        return { status: 'failed' as const, exitCode: result.exitCode, timedOut: true, timeoutMs, failedPhase: phase, ...detail, ...incomplete };
      }
      if (result.exitCode !== 0 || result.readError) {
        return { status: 'failed' as const, exitCode: result.exitCode, timedOut: false, failedPhase: phase, ...detail, ...incomplete };
      }
      return { status: 'success' as const, exitCode: 0, timedOut: false, ...incomplete };
    })();

    return { seq: this.seq + 1, ...body, ...counts };
  }

  private spawnFailure(phase: ComposePhase | undefined, error: unknown) {
    return {
      status: 'failed' as const,
      exitCode: null,
      timedOut: false,
      ...(phase ? { failedPhase: phase } : {}),
      code: 'compose_spawn_failed',
      detail: describeError(error).slice(0, MAX_DETAIL_CHARS),
    };
  }

  private emitPhase(phase: ComposePhase, timeoutMs?: number): void {
    this.lastPhase = phase;
    this.notify({ event: 'phase', data: { seq: ++this.seq, phase, ...(timeoutMs === undefined ? {} : { timeoutMs }) } });
  }

  private emitLine(stream: OutputStreamName, text: string, truncated: boolean): void {
    if (this.resultFrame) return;
    const data: ComposeLineFrame = { seq: ++this.seq, stream, text, ...(truncated ? { truncated: true as const } : {}) };
    this.recentLines.push(data);
    if (this.recentLines.length > RETAINED_LINES) this.recentLines.shift();
    this.notify({ event: 'line', data });
  }

  private notify(frame: ComposeFrameEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(frame);
      } catch (error) {
        console.error(`Compose run ${this.runId} subscriber failed:`, error);
      }
    }
  }
}

export interface ComposeRunRegistryOptions {
  retentionMs?: number;
  maxRuns?: number;
  now?: () => number;
  limits?: RunLimits;
}

/** In-memory index of compose runs. Finished runs linger so a later re-attach can read their result, running ones are never evicted. */
export class ComposeRunRegistry {
  private readonly runs = new Map<string, ComposeRun>();
  private readonly retentionMs: number;
  private readonly maxRuns: number;
  private readonly now: () => number;
  private readonly limits: RunLimits | undefined;

  constructor(options: ComposeRunRegistryOptions = {}) {
    this.retentionMs = options.retentionMs ?? RUN_RETENTION_MS;
    this.maxRuns = options.maxRuns ?? MAX_RETAINED_RUNS;
    this.now = options.now ?? Date.now;
    this.limits = options.limits;
  }

  create(action: ComposeAction, stack: string): ComposeRun {
    const run = new ComposeRun(action, stack, this.now, () => this.prune(), this.limits);
    this.runs.set(run.runId, run);
    this.prune();
    return run;
  }

  get(runId: string): ComposeRun | undefined {
    this.prune();
    return this.runs.get(runId);
  }

  get size(): number {
    this.prune();
    return this.runs.size;
  }

  private prune(): void {
    const t = this.now();
    for (const [id, run] of this.runs) {
      if (run.finishedAt !== null && t - run.finishedAt >= this.retentionMs) this.runs.delete(id);
    }
    let excess = this.runs.size - this.maxRuns;
    for (const [id, run] of this.runs) {
      if (excess <= 0) break;
      if (run.finishedAt !== null) {
        this.runs.delete(id);
        excess--;
      }
    }
  }
}

export const composeRunRegistry = new ComposeRunRegistry();

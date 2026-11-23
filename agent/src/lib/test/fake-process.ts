const encoder = new TextEncoder();

type Chunk = string | Uint8Array<ArrayBuffer>;

const toBytes = (chunk: Chunk): Uint8Array<ArrayBuffer> =>
  typeof chunk === 'string' ? encoder.encode(chunk) : chunk;

export function streamOf(...chunks: Chunk[]): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(toBytes(chunk));
      controller.close();
    },
  });
}

/** A process that has already produced its output and exited. */
export function finishedProcess(opts: { stdout?: Chunk[]; stderr?: Chunk[]; exitCode?: number } = {}) {
  return {
    exited: Promise.resolve(opts.exitCode ?? 0),
    stdout: streamOf(...(opts.stdout ?? [])),
    stderr: streamOf(...(opts.stderr ?? [])),
  };
}

/** A process whose stdout read fails. It reports `exitCode` at once, or only once it is killed. */
export function unreadableProcess(exitCode: number, exitsOn: 'spawn' | 'kill') {
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  if (exitsOn === 'spawn') resolveExit(exitCode);
  return {
    exited,
    stdout: new ReadableStream<Uint8Array<ArrayBuffer>>({ pull(controller) { controller.error(new Error('pipe broke')); } }),
    stderr: streamOf(),
    kill: () => { resolveExit(exitCode); },
  };
}

/** A process the test drives by hand: output and exit happen when the test says so. `kill` exits it with 137. */
export class ControlledProcess {
  readonly exited: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array<ArrayBuffer>>;
  readonly stderr: ReadableStream<Uint8Array<ArrayBuffer>>;
  killed = 0;
  private resolveExit!: (code: number) => void;
  private readonly controllers = {} as Record<'stdout' | 'stderr', ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>>;

  constructor() {
    this.exited = new Promise((resolve) => { this.resolveExit = resolve; });
    this.stdout = new ReadableStream({ start: (c) => { this.controllers.stdout = c; } });
    this.stderr = new ReadableStream({ start: (c) => { this.controllers.stderr = c; } });
  }

  write(stream: 'stdout' | 'stderr', chunk: Chunk): void {
    this.controllers[stream].enqueue(toBytes(chunk));
  }

  exit(code: number): void {
    this.controllers.stdout.close();
    this.controllers.stderr.close();
    this.resolveExit(code);
  }

  kill = () => {
    this.killed++;
    this.exit(137);
  };
}

/**
 * A process whose stdout is produced only as fast as the reader pulls it, and which exits only once
 * everything has been read. A reader that stops draining leaves `exited` pending forever.
 */
export function backpressuredProcess(chunks: Chunk[], exitCode = 0) {
  let index = 0;
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  const stdout = new ReadableStream<Uint8Array<ArrayBuffer>>(
    {
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(toBytes(chunks[index++]));
          return;
        }
        controller.close();
        resolveExit(exitCode);
      },
    },
    { highWaterMark: 0 },
  );
  return { exited, stdout, stderr: streamOf() };
}

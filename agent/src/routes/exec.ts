import type Dockerode from 'dockerode';
import type { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';

/** Candidate shells probed in order when preferred is 'auto'. */
const PROBE_SHELLS = ['bash', 'sh', 'ash'] as const;

interface ExecInstance {
  start(opts: { hijack: boolean; stdin: boolean }): Promise<Duplex>;
  resize(opts: { h: number; w: number }): Promise<void>;
  inspect(): Promise<{ ExitCode: number }>;
}

interface ResizeMessage {
  type: 'resize';
  cols: number;
  rows: number;
}

/**
 * Determine which shell binary is available in the container.
 *
 * When `preferred` is `'auto'`, probes bash, sh, and ash in that order by
 * running `<shell> -c 'exit 0'` with Tty:false and checking ExitCode. The
 * first shell that exits 0 is returned. Returns `''` when none succeed.
 *
 * When `preferred` is any other string, it is returned directly without
 * probing — the caller is responsible for choosing a valid shell name.
 *
 * @param container - Dockerode container instance
 * @param preferred - Shell name to use, or 'auto' to probe
 * @returns Resolved shell name, or '' if no supported shell found
 */
export async function probeShell(container: Dockerode.Container, preferred: string): Promise<string> {
  if (preferred !== 'auto') return preferred;

  for (const shell of PROBE_SHELLS) {
    try {
      const exec = await container.exec({
        Cmd: [shell, '-c', 'exit 0'],
        AttachStdout: false,
        AttachStderr: false,
        AttachStdin: false,
        Tty: false,
      }) as unknown as ExecInstance;

      // Start the probe process and wait for it to exit before inspecting.
      // inspect() returns ExitCode -1 while the process is still running, so
      // reading it before the stream ends is a race that produces false negatives.
      // The 5s timeout prevents an indefinite hang if the container is paused
      // or the exec process never exits; inspect() will return -1 in that case
      // and the probe correctly falls through to the next candidate.
      const stream = await exec.start({ hijack: true, stdin: false });
      await Promise.race([
        new Promise<void>((resolve) => {
          (stream as unknown as EventEmitter).once('end', resolve);
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
      const { ExitCode } = await exec.inspect();
      if (ExitCode === 0) return shell;
    } catch {
      // Shell not found or exec failed; try next candidate.
    }
  }

  return '';
}

/**
 * Process a single WebSocket message from the terminal client.
 *
 * JSON strings with `{ type: 'resize', cols, rows }` resize the PTY.
 * All other messages (binary Buffer or non-resize string) are forwarded
 * directly to the exec stream as stdin.
 *
 * @param message - Raw WebSocket message (string or Buffer)
 * @param stream - Writable exec stream (stdin to the container process)
 * @param exec - Dockerode exec instance used for PTY resize
 */
export async function handleExecMessage(
  message: string | Buffer,
  stream: Pick<Duplex, 'write'>,
  exec: Pick<ExecInstance, 'resize'>,
): Promise<void> {
  if (typeof message === 'string') {
    try {
      const parsed = JSON.parse(message) as unknown;
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        (parsed as ResizeMessage).type === 'resize'
      ) {
        const { cols, rows } = parsed as ResizeMessage;
        await exec.resize({ h: rows, w: cols });
        return;
      }
    } catch {
      // Not JSON — treat as raw stdin.
    }
    stream.write(message);
  } else {
    stream.write(message);
  }
}

interface ExecSocketData {
  shell: string;
  cols: number;
  rows: number;
  execStream?: Duplex;
  execInstance?: ExecInstance;
}

interface WsHandle {
  send(data: Buffer | string): void;
  close(code: number, reason: string): void;
  data: ExecSocketData;
}

/**
 * Open a TTY exec session inside a container and wire it to a WebSocket.
 *
 * Reads `ws.data.{ shell, cols, rows }`. If `shell` is `'auto'`, probes
 * bash/sh/ash in order. Closes the socket with 1011 if no shell is found.
 *
 * On success:
 * - Starts a TTY exec with the resolved shell.
 * - Sets initial PTY dimensions via exec.resize.
 * - Forwards exec stream `data` chunks to `ws.send`.
 * - Closes the socket (1000) when the exec stream ends.
 * - Closes the socket (1011) on exec stream error.
 * - Stores `execStream` and `execInstance` on `ws.data` so the caller's
 *   `message` and `close` handlers can forward stdin and handle cleanup.
 *
 * @param docker - Dockerode client
 * @param containerId - Target container ID or name
 * @param ws - Bun WebSocket handle with `data: ExecSocketData`
 */
export async function handleExecSocket(
  docker: Pick<Dockerode, 'getContainer'>,
  containerId: string,
  ws: WsHandle,
): Promise<void> {
  const { shell: preferredShell, cols, rows } = ws.data;

  const container = docker.getContainer(containerId);
  const shell = await probeShell(container, preferredShell);

  if (shell === '') {
    ws.close(1011, 'No supported shell found in container');
    return;
  }

  try {
    const exec = await container.exec({
      Cmd: [shell],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    }) as unknown as ExecInstance;

    const stream = await exec.start({ hijack: true, stdin: true });

    // Set the initial PTY size to match what the client reported.
    await exec.resize({ h: rows, w: cols });

    // Expose stream and exec instance for the WS message/close handlers.
    ws.data.execStream = stream;
    ws.data.execInstance = exec;

    let closed = false;

    stream.on('data', (chunk: Buffer) => {
      if (closed) return;
      try { ws.send(chunk); } catch { closed = true; }
    });

    stream.on('end', () => {
      if (closed) return;
      closed = true;
      try { ws.close(1000, 'Shell exited'); } catch { /* already closed */ }
      stream.destroy();
    });

    stream.on('error', (err: Error) => {
      if (closed) return;
      closed = true;
      console.error(`Exec stream error for container ${containerId}:`, err.message);
      try { ws.close(1011, 'Exec stream error'); } catch { /* already closed */ }
      stream.destroy();
    });
  } catch (err) {
    console.error(`Failed to start exec session for container ${containerId}:`, err);
    ws.close(1011, 'Failed to start exec session');
  }
}

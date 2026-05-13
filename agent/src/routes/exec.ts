import type Dockerode from 'dockerode';
import type { Duplex } from 'node:stream';
import net from 'node:net';

/**
 * Candidate shells probed in order when preferred is 'auto'.
 *
 * zsh is intentionally absent here even though it appears in
 * ALLOWED_EXPLICIT_SHELLS: zsh has a slow startup and is rare in containers,
 * so probing for it on every auto session would add latency for the common
 * case. A user who specifically wants zsh can request it by name.
 */
const PROBE_SHELLS = ['bash', 'sh', 'ash'] as const;

/** Shells the client is allowed to request explicitly. Anything else is rejected. */
const ALLOWED_EXPLICIT_SHELLS = new Set(['bash', 'sh', 'ash', 'zsh']);

interface ExecInstance {
  id?: string;
  start(opts: { hijack: boolean; stdin: boolean }): Promise<Duplex>;
  resize(opts: { h: number; w: number }): Promise<void>;
  inspect(): Promise<{ ExitCode: number }>;
}

/**
 * Start a Docker exec with an HTTP Upgrade and return the hijacked socket.
 *
 * dockerode's `exec.start({ hijack: true })` listens for `req.on('upgrade')`,
 * but Bun's `node:http` polyfill fires `req.on('response')` with statusCode
 * 101 instead, so the upgrade callback never resolves. We do the upgrade by
 * hand over a raw TCP socket so the returned Duplex works in Bun.
 */
export interface ExecRawTcpResult {
  /** The hijacked TCP socket. Use directly as a Duplex for stdin/stdout. */
  socket: net.Socket;
  /** Bytes already received past the HTTP response (e.g. shell prompt). Empty if none. */
  initialBytes: Buffer;
}

export async function startExecRawTcp(
  host: string,
  port: number,
  execId: string,
): Promise<ExecRawTcpResult> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ Detach: false, Tty: true });
    const httpReq =
      `POST /exec/${execId}/start HTTP/1.1\r\n` +
      `Host: ${host}:${port}\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      `Connection: Upgrade\r\n` +
      `Upgrade: tcp\r\n` +
      `\r\n` +
      body;

    const sock = net.connect({ host, port });
    let buffer = Buffer.alloc(0);
    let resolved = false;

    const onError = (err: Error) => {
      if (resolved) return;
      resolved = true;
      sock.destroy();
      reject(err);
    };

    const onData = (chunk: Buffer) => {
      if (resolved) return;
      buffer = Buffer.concat([buffer, chunk]);
      const idx = buffer.indexOf(Buffer.from('\r\n\r\n'));
      if (idx === -1) return;
      const headerStr = buffer.subarray(0, idx).toString('utf8');
      const remainder = buffer.subarray(idx + 4);
      const statusLine = headerStr.split('\r\n')[0];
      const match = /^HTTP\/1\.\d (\d+)/.exec(statusLine);
      if (!match) {
        onError(new Error(`Bad HTTP response: ${statusLine}`));
        return;
      }
      const status = Number(match[1]);
      if (status !== 101) {
        onError(new Error(`Expected 101 Switching Protocols, got ${status}: ${headerStr}`));
        return;
      }
      resolved = true;
      sock.removeListener('data', onData);
      sock.removeListener('error', onError);
      resolve({ socket: sock, initialBytes: remainder });
    };

    sock.once('connect', () => sock.write(httpReq));
    sock.on('data', onData);
    sock.on('error', onError);
  });
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
 * When `preferred` is any other string, it must exactly match one of the
 * shells in `ALLOWED_EXPLICIT_SHELLS`; otherwise `''` is returned. The
 * whitelist prevents the query-string-provided `shell` from being a vehicle
 * for command injection via `container.exec({ Cmd: [shell] })`.
 *
 * @param container - Dockerode container instance
 * @param preferred - Shell name to use, or 'auto' to probe
 * @returns Resolved shell name, or '' if no supported shell found
 */
export async function probeShell(container: Dockerode.Container, preferred: string): Promise<string> {
  if (preferred !== 'auto') {
    return ALLOWED_EXPLICIT_SHELLS.has(preferred) ? preferred : '';
  }

  for (const shell of PROBE_SHELLS) {
    try {
      const exec = await container.exec({
        Cmd: [shell, '-c', 'exit 0'],
        AttachStdout: false,
        AttachStderr: false,
        AttachStdin: false,
        Tty: false,
      }) as unknown as ExecInstance;

      // Detach:true starts the process without attaching any stream and
      // returns immediately. hijack:true (the interactive mode) keeps the TCP
      // connection open waiting for muxed output, and with no outputs attached
      // the stream never emits 'end', so every probe hit the 5s timeout and
      // then received ExitCode -1 (process already exited but socket still open).
      await (exec as unknown as { start(o: { Detach: boolean }): Promise<void> }).start({ Detach: true });

      // Poll until Docker sets ExitCode; it returns -1 while the process is
      // still running. 'exit 0' completes in <50ms but slower hosts or proxies
      // can add overhead; 5s avoids false "no shell found" failures.
      const deadline = Date.now() + 5_000;
      let { ExitCode } = await exec.inspect();
      while (ExitCode === -1 && Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 50));
        ({ ExitCode } = await exec.inspect());
      }
      if (ExitCode === 0) return shell;
      if (ExitCode === -1) {
        // Distinguish a slow/stuck Docker from "shell does not exist": a clean
        // failure sets a non-zero exit code, but -1 after 5s means the probe
        // process never reported back. Operator needs to know this is not a
        // missing-shell scenario before the user sees 1011 "No supported shell".
        console.warn('exec probe deadline expired (still running after 5s)', {
          shell,
          containerId: container.id,
          exitCode: -1,
        });
      }
    } catch (err) {
      // Surface the actual error so an operator can diagnose Docker daemon
      // problems (ECONNREFUSED, EPIPE, broken socket) instead of seeing
      // "No supported shell found in container" 3 swallowed failures later.
      console.error('exec probe failed', {
        shell,
        containerId: container.id,
        err: err instanceof Error ? err.message : String(err),
      });
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
  if (typeof message !== 'string') {
    stream.write(message);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    // Not JSON; treat as raw stdin.
    stream.write(message);
    return;
  }

  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    (parsed as Partial<ResizeMessage>).type === 'resize'
  ) {
    const { cols, rows } = parsed as Partial<ResizeMessage>;
    if (Number.isFinite(cols) && Number.isFinite(rows)) {
      // Swallow resize failures: a transient Docker error must not cause the
      // resize JSON payload to be typed into the user's shell.
      try {
        await exec.resize({
          h: Math.max(1, Math.min(rows as number, 500)),
          w: Math.max(1, Math.min(cols as number, 500)),
        });
      } catch {
        // resize is best-effort; the PTY keeps its previous size
      }
    }
    return;
  }

  // Valid JSON but not a resize message: forward as raw stdin (rare; user
  // could legitimately type JSON in their shell).
  stream.write(message);
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
  dockerHost: string,
  dockerPort: number,
  containerId: string,
  ws: WsHandle,
  startStream: (host: string, port: number, execId: string) => Promise<ExecRawTcpResult> =
    startExecRawTcp,
): Promise<void> {
  // Messages arriving before execStream is set on ws.data are silently dropped by
  // the Bun.serve message handler. This window is short (shell probe + exec start),
  // and the client typically isn't typing yet because the terminal is still painting.
  const { shell: preferredShell } = ws.data;
  // Math.min(NaN, 500) is NaN, which Docker rejects. Guard with isFinite and
  // fall back to xterm defaults so malformed cols/rows don't break the session.
  const cols = Number.isFinite(ws.data.cols) ? Math.max(1, Math.min(ws.data.cols, 500)) : 80;
  const rows = Number.isFinite(ws.data.rows) ? Math.max(1, Math.min(ws.data.rows, 500)) : 24;

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
      Env: ['TERM=xterm-256color'],
    }) as unknown as ExecInstance;
    if (!exec.id) throw new Error('container.exec returned exec without id');

    // Use raw TCP HTTP upgrade rather than `exec.start({ hijack: true })`
    // because Bun's node:http fires 'response' for 101 instead of 'upgrade',
    // causing dockerode's hijack callback to hang forever.
    const { socket, initialBytes } = await startStream(dockerHost, dockerPort, exec.id);
    const stream: Duplex = socket;

    // Announce the resolved shell as a JSON text control frame so the client
    // can show e.g. `auto (sh)` in the shell picker. Sent before any binary
    // output; binary frames are terminal stdout/stderr. If this throws the
    // WS is already dead, so tear down the Docker socket and bail rather than
    // attaching listeners and starting the async iterator on an orphan exec.
    try {
      ws.send(JSON.stringify({ type: 'shell', name: shell }));
    } catch (err) {
      console.error(`Failed to announce shell for container ${containerId}:`, err instanceof Error ? err.message : String(err));
      socket.destroy();
      return;
    }

    // Wire up listeners before resize so exec output is never buffered without
    // a consumer. resize() is a separate HTTP round-trip that can be slow or
    // hang through a socket proxy; blocking on it would leave the stream
    // producing data with no listener attached.
    ws.data.execStream = stream;
    ws.data.execInstance = exec;

    let closed = false;

    // Forward bytes that arrived past the HTTP response (typical: shell prompt).
    // If the send throws, the WS is dead: destroy the Docker socket now rather
    // than relying on the async-iter loop to notice on its first chunk (which
    // may never arrive on a quiet shell), and skip the resize.
    if (initialBytes.length > 0) {
      try {
        ws.send(initialBytes);
      } catch (err) {
        console.error(`Failed to send initial bytes for container ${containerId}:`, err instanceof Error ? err.message : String(err));
        closed = true;
        socket.destroy();
        return;
      }
    }

    // Fire-and-forget the initial resize: PTY starts at Docker's default
    // (80x24) and jumps to the client's reported size once this resolves.
    void exec.resize({ h: rows, w: cols }).catch((e: Error) => {
      console.error(`Exec resize failed for ${containerId}:`, e.message);
    });

    // Use async iteration rather than the 'data' event listener. Bun's Node.js
    // compat layer doesn't reliably emit 'data' events on the raw TCP socket,
    // but Symbol.asyncIterator works on the same stream object.
    void (async () => {
      try {
        for await (const chunk of stream as AsyncIterable<Buffer>) {
          if (closed) break;
          try {
            ws.send(chunk as Buffer);
          } catch (err) {
            // WS gone: stop iterating and destroy the Docker socket so the
            // upstream TCP connection doesn't leak waiting for the next chunk.
            console.error(`Failed to forward exec chunk for container ${containerId}:`, err instanceof Error ? err.message : String(err));
            closed = true;
            socket.destroy();
            break;
          }
        }
      } catch (err) {
        if (!closed) {
          closed = true;
          console.error(`Exec stream error for container ${containerId}:`, err instanceof Error ? err.message : String(err));
          try { ws.close(1011, 'Exec stream error'); } catch { /* already closed */ }
        }
        return;
      }
      if (!closed) {
        closed = true;
        try { ws.close(1000, 'Shell exited'); } catch { /* already closed */ }
      }
    })();

    // Keep the old event-listener stubs so ws.data.execStream.destroy() in the
    // close handler still terminates the loop above via the stream error path.
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

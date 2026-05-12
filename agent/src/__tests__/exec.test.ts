import { describe, expect, test, mock, beforeAll } from 'bun:test';
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

  test('returns explicit shell without probing', async () => {
    const container = makeMockContainer();
    const shell = await probeShell(container as any, 'zsh');
    expect(shell).toBe('zsh');
    expect(container.exec).not.toHaveBeenCalled();
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
});

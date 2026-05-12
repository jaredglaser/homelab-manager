import { describe, expect, test, mock, beforeAll } from 'bun:test';
import { EventEmitter } from 'node:events';

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

const { probeShell, handleExecSocket, handleExecMessage } = await import('../routes/exec');

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

    await handleExecSocket(mockDocker as any, 'abc123', mockWs as any);

    expect(mockWs.close).toHaveBeenCalledWith(1011, 'No supported shell found in container');
  });

  test('sends exec output to WebSocket', async () => {
    const execEmitter = new EventEmitter();
    let probeCallCount = 0;

    const mockContainer = {
      exec: mock(async (opts: { Cmd: string[]; Tty?: boolean }) => {
        if (!opts.Tty) {
          // Probe call
          probeCallCount++;
          const probe = new EventEmitter();
          return {
            start: mock(async () => { setTimeout(() => probe.emit('end'), 5); return probe; }),
            inspect: mock(async () => ({ ExitCode: 0 })),
            resize: mock(async () => {}),
          };
        }
        // Actual exec
        return {
          start: mock(async () => execEmitter),
          inspect: mock(async () => ({ ExitCode: 0 })),
          resize: mock(async () => {}),
        };
      }),
    };

    const mockDocker = { getContainer: mock(() => mockContainer) };
    const mockWs = { send: mock(() => {}), close: mock(() => {}), data: { shell: 'bash', cols: 80, rows: 24 } };

    await handleExecSocket(mockDocker as any, 'abc123', mockWs as any);

    execEmitter.emit('data', Buffer.from('hello'));
    await new Promise((r) => setTimeout(r, 10));

    expect(mockWs.send).toHaveBeenCalledWith(Buffer.from('hello'));
  });

  test('closes WebSocket with 1000 when exec stream ends', async () => {
    const execEmitter = Object.assign(new EventEmitter(), { destroy: mock(() => {}) });
    const mockContainer = {
      exec: mock(async (opts: { Cmd: string[]; Tty?: boolean }) => {
        if (!opts.Tty) {
          const probe = new EventEmitter();
          return {
            start: mock(async () => { setTimeout(() => probe.emit('end'), 5); return probe; }),
            inspect: mock(async () => ({ ExitCode: 0 })),
            resize: mock(async () => {}),
          };
        }
        return {
          start: mock(async () => execEmitter),
          inspect: mock(async () => ({ ExitCode: 0 })),
          resize: mock(async () => {}),
        };
      }),
    };
    const mockDocker = { getContainer: mock(() => mockContainer) };
    const mockWs = { send: mock(() => {}), close: mock(() => {}), data: { shell: 'bash', cols: 80, rows: 24 } };

    await handleExecSocket(mockDocker as any, 'abc123', mockWs as any);

    execEmitter.emit('end');
    await new Promise((r) => setTimeout(r, 10));

    expect(mockWs.close).toHaveBeenCalledWith(1000, 'Shell exited');
  });

  test('closes WebSocket with 1011 when exec stream errors', async () => {
    const execEmitter = Object.assign(new EventEmitter(), { destroy: mock(() => {}) });
    const mockContainer = {
      exec: mock(async (opts: { Cmd: string[]; Tty?: boolean }) => {
        if (!opts.Tty) {
          const probe = new EventEmitter();
          return {
            start: mock(async () => { setTimeout(() => probe.emit('end'), 5); return probe; }),
            inspect: mock(async () => ({ ExitCode: 0 })),
            resize: mock(async () => {}),
          };
        }
        return {
          start: mock(async () => execEmitter),
          inspect: mock(async () => ({ ExitCode: 0 })),
          resize: mock(async () => {}),
        };
      }),
    };
    const mockDocker = { getContainer: mock(() => mockContainer) };
    const mockWs = { send: mock(() => {}), close: mock(() => {}), data: { shell: 'bash', cols: 80, rows: 24 } };

    await handleExecSocket(mockDocker as any, 'abc123', mockWs as any);

    execEmitter.emit('error', new Error('pipe broken'));
    await new Promise((r) => setTimeout(r, 10));

    expect(mockWs.close).toHaveBeenCalledWith(1011, 'Exec stream error');
  });
});

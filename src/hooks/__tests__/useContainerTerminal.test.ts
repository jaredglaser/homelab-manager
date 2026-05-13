import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';

// Mock WebSocket. Real WebSockets start in CONNECTING (0) and only transition
// to OPEN (1) after the handshake; the hook gates ws.send on OPEN, so the mock
// must replicate that or a regression that sends stdin before open would slip
// through. Tests call `triggerOpen()` to advance the state.
const mockWsInstances: MockWebSocket[] = [];

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = MockWebSocket.CONNECTING;
  binaryType = 'blob';
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  send = mock(() => {});
  close = mock(() => { this.readyState = MockWebSocket.CLOSED; });

  constructor(public url: string) {
    mockWsInstances.push(this);
  }

  triggerOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }
}

(globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket;

// Mock xterm Terminal with onData and onResize
type Listener = (data: unknown) => void;
const listeners: Record<string, Listener> = {};

const mockTerminal = {
  cols: 80,
  rows: 24,
  write: mock(() => {}),
  onData: mock((cb: Listener) => { listeners['data'] = cb; return { dispose: mock(() => {}) }; }),
  onResize: mock((cb: Listener) => { listeners['resize'] = cb; return { dispose: mock(() => {}) }; }),
};

const { useContainerTerminal } = await import('@/hooks/useContainerTerminal');

/** Settle effects and transition the latest MockWebSocket to OPEN, mirroring the real handshake. */
async function settleAndOpen(): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  await act(async () => { mockWsInstances.at(-1)?.triggerOpen(); });
}

/** For tests that assert NO WebSocket is constructed (enabled=false, terminal=null). */
async function flushMicrotasksWithoutOpening(): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
}

describe('useContainerTerminal', () => {
  beforeEach(() => {
    mockWsInstances.length = 0;
    mockTerminal.write.mockClear();
    mockTerminal.onData.mockClear();
    mockTerminal.onResize.mockClear();
  });

  it('returns isConnected true after WebSocket opens', async () => {
    const { result } = renderHook(() =>
      useContainerTerminal({
        containerId: 'abc123',
        host: 'server1',
        shell: 'bash',
        terminal: mockTerminal as unknown as import('@xterm/xterm').Terminal,
      }),
    );
    await settleAndOpen();
    expect(result.current.isConnected).toBe(true);
  });

  it('builds correct WebSocket URL', async () => {
    renderHook(() =>
      useContainerTerminal({
        containerId: 'my-container',
        host: 'server1',
        shell: 'bash',
        terminal: mockTerminal as unknown as import('@xterm/xterm').Terminal,
      }),
    );
    await settleAndOpen();
    expect(mockWsInstances[0]?.url).toContain('/api/docker-exec/my-container');
    expect(mockWsInstances[0]?.url).toContain('host=server1');
    expect(mockWsInstances[0]?.url).toContain('shell=bash');
  });

  it('updates resolvedShell when receiving the shell control frame', async () => {
    const { result } = renderHook(() =>
      useContainerTerminal({
        containerId: 'abc123',
        host: 'server1',
        shell: 'auto',
        terminal: mockTerminal as unknown as import('@xterm/xterm').Terminal,
      }),
    );
    await settleAndOpen();
    const ws = mockWsInstances[0]!;
    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: 'shell', name: 'sh' }) } as MessageEvent);
    });
    expect(result.current.resolvedShell).toBe('sh');
    expect(mockTerminal.write).not.toHaveBeenCalled();
  });

  it('ignores non-JSON text frames without writing to the terminal', async () => {
    const { result } = renderHook(() =>
      useContainerTerminal({
        containerId: 'abc123',
        host: 'server1',
        shell: 'auto',
        terminal: mockTerminal as unknown as import('@xterm/xterm').Terminal,
      }),
    );
    await settleAndOpen();
    const ws = mockWsInstances[0]!;
    act(() => { ws.onmessage?.({ data: 'not-json-at-all' } as MessageEvent); });
    expect(result.current.resolvedShell).toBeUndefined();
    expect(mockTerminal.write).not.toHaveBeenCalled();
  });

  it('writes incoming ArrayBuffer messages to terminal', async () => {
    renderHook(() =>
      useContainerTerminal({
        containerId: 'abc123',
        host: 'server1',
        shell: 'bash',
        terminal: mockTerminal as unknown as import('@xterm/xterm').Terminal,
      }),
    );
    await settleAndOpen();
    const ws = mockWsInstances[0]!;
    act(() => { ws.onmessage?.({ data: new ArrayBuffer(4) } as MessageEvent); });
    expect(mockTerminal.write).toHaveBeenCalledWith(expect.any(Uint8Array));
  });

  it('sends stdin keypresses over WebSocket', async () => {
    renderHook(() =>
      useContainerTerminal({
        containerId: 'abc123',
        host: 'server1',
        shell: 'bash',
        terminal: mockTerminal as unknown as import('@xterm/xterm').Terminal,
      }),
    );
    await settleAndOpen();
    act(() => { listeners['data']?.('ls\r'); });
    expect(mockWsInstances[0]?.send).toHaveBeenCalledWith('ls\r');
  });

  it('sends resize JSON message on terminal resize', async () => {
    renderHook(() =>
      useContainerTerminal({
        containerId: 'abc123',
        host: 'server1',
        shell: 'bash',
        terminal: mockTerminal as unknown as import('@xterm/xterm').Terminal,
      }),
    );
    await settleAndOpen();
    act(() => { listeners['resize']?.({ cols: 120, rows: 40 }); });
    const allCalls = mockWsInstances[0]?.send.mock.calls as unknown as unknown[][];
    const call = allCalls?.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('"type":"resize"'),
    );
    expect(call).toBeTruthy();
    expect(JSON.parse(call![0] as string)).toEqual({ type: 'resize', cols: 120, rows: 40 });
  });

  it('marks sessionEnded (not error) on a clean close', async () => {
    const { result } = renderHook(() =>
      useContainerTerminal({
        containerId: 'abc123',
        host: 'server1',
        shell: 'bash',
        terminal: mockTerminal as unknown as import('@xterm/xterm').Terminal,
      }),
    );
    await settleAndOpen();
    const ws = mockWsInstances[0]!;
    act(() => { ws.onclose?.({ code: 1000, reason: 'Shell exited' } as CloseEvent); });
    expect(result.current.sessionEnded).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.isConnected).toBe(false);
  });

  it('reconnect() opens a new WebSocket and clears sessionEnded', async () => {
    const { result } = renderHook(() =>
      useContainerTerminal({
        containerId: 'abc123',
        host: 'server1',
        shell: 'bash',
        terminal: mockTerminal as unknown as import('@xterm/xterm').Terminal,
      }),
    );
    await settleAndOpen();
    expect(mockWsInstances.length).toBe(1);
    act(() => { mockWsInstances[0]!.onclose?.({ code: 1000, reason: '' } as CloseEvent); });
    expect(result.current.sessionEnded).toBe(true);
    await act(async () => { result.current.reconnect(); await new Promise((r) => setTimeout(r, 10)); });
    act(() => { mockWsInstances.at(-1)?.triggerOpen(); });
    expect(mockWsInstances.length).toBe(2);
    expect(result.current.sessionEnded).toBe(false);
  });

  it('sets error on non-normal close code', async () => {
    const { result } = renderHook(() =>
      useContainerTerminal({
        containerId: 'abc123',
        host: 'server1',
        shell: 'bash',
        terminal: mockTerminal as unknown as import('@xterm/xterm').Terminal,
      }),
    );
    await settleAndOpen();
    const ws = mockWsInstances[0]!;
    act(() => { ws.onclose?.({ code: 1011, reason: 'Shell exited' } as CloseEvent); });
    expect(result.current.error).not.toBeNull();
    expect(result.current.isConnected).toBe(false);
  });

  it('does not connect when enabled is false', async () => {
    renderHook(() =>
      useContainerTerminal({
        containerId: 'abc123',
        host: 'server1',
        shell: 'bash',
        terminal: mockTerminal as unknown as import('@xterm/xterm').Terminal,
        enabled: false,
      }),
    );
    await flushMicrotasksWithoutOpening();
    expect(mockWsInstances.length).toBe(0);
  });

  it('does not connect when terminal is null', async () => {
    renderHook(() =>
      useContainerTerminal({
        containerId: 'abc123',
        host: 'server1',
        shell: 'bash',
        terminal: null,
      }),
    );
    await flushMicrotasksWithoutOpening();
    expect(mockWsInstances.length).toBe(0);
  });

  it('drops stdin sent before the socket opens, forwards stdin after open', async () => {
    // Real WebSockets start in CONNECTING; useContainerTerminal gates ws.send
    // on readyState === OPEN. A regression that removed that gate would send
    // bytes against a not-yet-connected socket. The mock starts in CONNECTING
    // until triggerOpen() flips it.
    renderHook(() =>
      useContainerTerminal({
        containerId: 'abc123',
        host: 'server1',
        shell: 'bash',
        terminal: mockTerminal as unknown as import('@xterm/xterm').Terminal,
      }),
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const ws = mockWsInstances[0]!;
    // Pre-open: type before the OPEN transition.
    act(() => { listeners['data']?.('typed-before-open\r'); });
    expect(ws.send).not.toHaveBeenCalled();

    // Now open the socket.
    await act(async () => { ws.triggerOpen(); });
    act(() => { listeners['data']?.('typed-after-open\r'); });
    expect(ws.send).toHaveBeenCalledWith('typed-after-open\r');
  });

  it('sets error.message to the WS close reason on non-normal close', async () => {
    const { result } = renderHook(() =>
      useContainerTerminal({
        containerId: 'abc123',
        host: 'server1',
        shell: 'bash',
        terminal: mockTerminal as unknown as import('@xterm/xterm').Terminal,
      }),
    );
    await settleAndOpen();
    const ws = mockWsInstances[0]!;
    act(() => {
      ws.onclose?.({ code: 1011, reason: 'No supported shell found in container' } as CloseEvent);
    });
    expect(result.current.error).not.toBeNull();
    expect(result.current.error!.message).toContain('No supported shell found in container');
  });

  it('preserves exact byte sequence (ANSI SGR + control chars) when writing to terminal', async () => {
    renderHook(() =>
      useContainerTerminal({
        containerId: 'abc123',
        host: 'server1',
        shell: 'bash',
        terminal: mockTerminal as unknown as import('@xterm/xterm').Terminal,
      }),
    );
    await settleAndOpen();
    const ws = mockWsInstances[0]!;
    // 0x1b 0x5b 0x33 0x6d = ESC [ 3 m  (SGR red foreground).
    // 0x03 = Ctrl-C. 0x41 = 'A'.
    const bytes = new Uint8Array([0x1b, 0x5b, 0x33, 0x6d, 0x41, 0x03]);
    act(() => { ws.onmessage?.({ data: bytes.buffer } as MessageEvent); });

    const calls = mockTerminal.write.mock.calls as unknown as unknown[][];
    expect(calls.length).toBe(1);
    const written = calls[0]![0] as Uint8Array;
    expect(written).toBeInstanceOf(Uint8Array);
    expect(Array.from(written)).toEqual(Array.from(bytes));
  });
});

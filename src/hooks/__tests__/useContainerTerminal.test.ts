import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';

// Mock WebSocket
const mockWsInstances: MockWebSocket[] = [];

class MockWebSocket {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  binaryType = 'blob';
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  send = mock(() => {});
  close = mock(() => { this.readyState = MockWebSocket.CLOSED; });

  constructor(public url: string) {
    mockWsInstances.push(this);
    // Simulate immediate open on next tick
    Promise.resolve().then(() => this.onopen?.(new Event('open')));
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
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
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
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(mockWsInstances[0]?.url).toContain('/api/docker-exec/my-container');
    expect(mockWsInstances[0]?.url).toContain('host=server1');
    expect(mockWsInstances[0]?.url).toContain('shell=bash');
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
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
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
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
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
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    act(() => { listeners['resize']?.({ cols: 120, rows: 40 }); });
    const allCalls = mockWsInstances[0]?.send.mock.calls as unknown as unknown[][];
    const call = allCalls?.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('"type":"resize"'),
    );
    expect(call).toBeTruthy();
    expect(JSON.parse(call![0] as string)).toEqual({ type: 'resize', cols: 120, rows: 40 });
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
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
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
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
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
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(mockWsInstances.length).toBe(0);
  });
});

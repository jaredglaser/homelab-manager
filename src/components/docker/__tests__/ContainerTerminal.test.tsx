import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { act, render, screen } from '@testing-library/react';

interface MockTerminalShape {
  options: Record<string, unknown>;
  loadAddon: ReturnType<typeof mock>;
  open: ReturnType<typeof mock>;
  dispose: ReturnType<typeof mock>;
  writeln: ReturnType<typeof mock>;
  onData: ReturnType<typeof mock>;
  onResize: ReturnType<typeof mock>;
  onLineFeed: ReturnType<typeof mock>;
  resize: ReturnType<typeof mock>;
  cols: number;
  rows: number;
  buffer: { active: { length: number; getLine: () => null; viewportY: number; cursorY: number } };
}
const mockTerminalInstances: MockTerminalShape[] = [];

mock.module('@xterm/xterm', () => ({
  default: {
    Terminal: class MockTerminal implements MockTerminalShape {
      options: Record<string, unknown> = {};
      loadAddon = mock(() => {});
      open = mock(() => {});
      dispose = mock(() => {});
      writeln = mock(() => {});
      onData = mock(() => ({ dispose: mock(() => {}) }));
      onResize = mock(() => ({ dispose: mock(() => {}) }));
      onLineFeed = mock(() => ({ dispose: mock(() => {}) }));
      resize = mock(() => {});
      cols = 80;
      rows = 24;
      buffer = { active: { length: 0, getLine: () => null, viewportY: 0, cursorY: 0 } };
      constructor(opts: Record<string, unknown>) {
        this.options = { ...opts };
        mockTerminalInstances.push(this);
      }
    },
  },
}));

mock.module('@xterm/addon-fit', () => ({
  default: { FitAddon: class { fit = mock(() => {}); activate = mock(() => {}); } },
}));

mock.module('@xterm/xterm/css/xterm.css', () => ({}));

interface MockHookReturn {
  isConnected: boolean;
  error: Error | null;
  resolvedShell?: string;
  sessionEnded: boolean;
  reconnect: () => void;
}
const defaultHookReturn: MockHookReturn = {
  isConnected: false,
  error: null,
  resolvedShell: undefined,
  sessionEnded: false,
  reconnect: () => {},
};
const mockUseContainerTerminal = mock(() => defaultHookReturn);
mock.module('@/hooks/useContainerTerminal', () => ({
  useContainerTerminal: mockUseContainerTerminal,
}));

class MockResizeObserver {
  observe = mock(() => {});
  disconnect = mock(() => {});
  unobserve = mock(() => {});
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;

const { default: ContainerTerminal } = await import('@/components/docker/ContainerTerminal');

describe('ContainerTerminal', () => {
  beforeEach(() => {
    mockUseContainerTerminal.mockReturnValue(defaultHookReturn);
    mockTerminalInstances.length = 0;
  });

  it('renders without crashing', () => {
    const { container } = render(
      <ContainerTerminal containerId="abc123" host="server1" shell="bash" frozen={false} wordWrap={false} />,
    );
    expect(container).toBeTruthy();
  });

  it('shows frozen overlay when frozen=true', () => {
    render(
      <ContainerTerminal containerId="abc123" host="server1" shell="bash" frozen={true} wordWrap={false} />,
    );
    expect(screen.getByText('Container stopped')).toBeTruthy();
  });

  it('does not show frozen overlay when frozen=false', () => {
    render(
      <ContainerTerminal containerId="abc123" host="server1" shell="bash" frozen={false} wordWrap={false} />,
    );
    expect(screen.queryByText('Container stopped')).toBeNull();
  });

  it('shows skeleton when not connected and not frozen', () => {
    const { container } = render(
      <ContainerTerminal containerId="abc123" host="server1" shell="bash" frozen={false} wordWrap={false} />,
    );
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('shows error overlay when error occurs and not frozen', () => {
    mockUseContainerTerminal.mockReturnValue({ ...defaultHookReturn, error: new Error('Connection refused') });
    render(<ContainerTerminal containerId="abc123" host="server1" shell="bash" frozen={false} wordWrap={false} />);
    expect(screen.getByText('Connection refused')).toBeTruthy();
  });

  it('shows Session ended overlay with Reconnect button when the WS closes cleanly', () => {
    mockUseContainerTerminal.mockReturnValue({ ...defaultHookReturn, sessionEnded: true });
    render(<ContainerTerminal containerId="abc123" host="server1" shell="bash" frozen={false} wordWrap={false} />);
    expect(screen.getByText('Session ended')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
  });

  it('shows frozen overlay and suppresses error overlay when both frozen and error are set', () => {
    mockUseContainerTerminal.mockReturnValue({
      ...defaultHookReturn,
      error: new Error('test error'),
    });
    render(
      <ContainerTerminal containerId="abc123" host="server1" shell="bash" frozen={true} wordWrap={false} />,
    );
    // frozen overlay must be visible
    expect(screen.getByText('Container stopped')).toBeTruthy();
    // error overlay is gated on !frozen, so it must not appear
    expect(screen.queryByText('test error')).toBeNull();
  });

  it('calls onShellResolved with the resolved shell name', async () => {
    const onShellResolved = mock(() => {});
    mockUseContainerTerminal.mockReturnValue({ ...defaultHookReturn, resolvedShell: 'bash' });
    render(
      <ContainerTerminal
        containerId="abc123"
        host="server1"
        shell="auto"
        frozen={false}
        wordWrap={false}
        onShellResolved={onShellResolved}
      />,
    );
    // The useEffect that calls onShellResolved runs after render; flush with act.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(onShellResolved).toHaveBeenCalledWith('bash');
  });

  it('flips terminal.options.disableStdin to match the frozen prop on rerender', async () => {
    // useXtermSetup creates the Terminal inside an async useEffect; wait a tick
    // inside act() so React state updates are committed before assertions.
    const { rerender } = render(
      <ContainerTerminal containerId="abc123" host="server1" shell="bash" frozen={false} wordWrap={false} />,
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const term = mockTerminalInstances.at(-1);
    if (!term) throw new Error('expected mock Terminal to be constructed');
    expect(term.options.disableStdin).toBe(false);

    await act(async () => {
      rerender(<ContainerTerminal containerId="abc123" host="server1" shell="bash" frozen={true} wordWrap={false} />);
    });
    expect(term.options.disableStdin).toBe(true);

    await act(async () => {
      rerender(<ContainerTerminal containerId="abc123" host="server1" shell="bash" frozen={false} wordWrap={false} />);
    });
    expect(term.options.disableStdin).toBe(false);
  });
});

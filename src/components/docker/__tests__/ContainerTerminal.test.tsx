import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen } from '@testing-library/react';

mock.module('@xterm/xterm', () => ({
  default: {
    Terminal: class MockTerminal {
      options: Record<string, unknown> = {};
      loadAddon = mock(() => {});
      open = mock(() => {});
      dispose = mock(() => {});
      writeln = mock(() => {});
      onData = mock(() => ({ dispose: mock(() => {}) }));
      onResize = mock(() => ({ dispose: mock(() => {}) }));
      cols = 80;
      rows = 24;
      constructor(opts: Record<string, unknown>) { this.options = { ...opts }; }
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
  sessionEnded: boolean;
  reconnect: () => void;
}
const defaultHookReturn: MockHookReturn = {
  isConnected: false,
  error: null,
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

const { default: ContainerTerminal } = await import('../ContainerTerminal');

describe('ContainerTerminal', () => {
  beforeEach(() => {
    mockUseContainerTerminal.mockReturnValue(defaultHookReturn);
  });

  it('renders without crashing', () => {
    const { container } = render(
      <ContainerTerminal containerId="abc123" host="server1" shell="bash" frozen={false} />,
    );
    expect(container).toBeTruthy();
  });

  it('shows frozen overlay when frozen=true', () => {
    render(
      <ContainerTerminal containerId="abc123" host="server1" shell="bash" frozen={true} />,
    );
    expect(screen.getByText('Container stopped')).toBeTruthy();
  });

  it('does not show frozen overlay when frozen=false', () => {
    render(
      <ContainerTerminal containerId="abc123" host="server1" shell="bash" frozen={false} />,
    );
    expect(screen.queryByText('Container stopped')).toBeNull();
  });

  it('shows skeleton when not connected and not frozen', () => {
    const { container } = render(
      <ContainerTerminal containerId="abc123" host="server1" shell="bash" frozen={false} />,
    );
    expect(container.querySelectorAll('.MuiSkeleton-root').length).toBeGreaterThan(0);
  });

  it('shows error overlay when error occurs and not frozen', () => {
    mockUseContainerTerminal.mockReturnValue({ ...defaultHookReturn, error: new Error('Connection refused') });
    render(<ContainerTerminal containerId="abc123" host="server1" shell="bash" frozen={false} />);
    expect(screen.getByText('Connection refused')).toBeTruthy();
  });

  it('shows Session ended overlay with Reconnect button when the WS closes cleanly', () => {
    mockUseContainerTerminal.mockReturnValue({ ...defaultHookReturn, sessionEnded: true });
    render(<ContainerTerminal containerId="abc123" host="server1" shell="bash" frozen={false} />);
    expect(screen.getByText('Session ended')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
  });
});

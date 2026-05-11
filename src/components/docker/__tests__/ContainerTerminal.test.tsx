import { describe, it, expect, mock } from 'bun:test';
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

mock.module('@/hooks/useContainerTerminal', () => ({
  useContainerTerminal: () => ({ isConnected: false, error: null }),
}));

class MockResizeObserver {
  observe = mock(() => {});
  disconnect = mock(() => {});
  unobserve = mock(() => {});
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;

const { default: ContainerTerminal } = await import('../ContainerTerminal');

describe('ContainerTerminal', () => {
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

  it('shows error overlay when error occurs and not frozen', async () => {
    mock.module('@/hooks/useContainerTerminal', () => ({
      useContainerTerminal: () => ({ isConnected: false, error: new Error('Connection refused') }),
    }));
    const { default: CT } = await import('../ContainerTerminal');
    render(<CT containerId="abc123" host="server1" shell="bash" frozen={false} />);
    expect(screen.getByText('Connection refused')).toBeTruthy();
  });
});

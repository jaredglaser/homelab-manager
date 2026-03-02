import { describe, it, expect, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';

// Mock xterm.js — CJS modules need default export for bun:test ESM loader
mock.module('@xterm/xterm', () => ({
  default: {
    Terminal: class MockTerminal {
      disableStdin = true;
      loadAddon = mock(() => {});
      open = mock(() => {});
      dispose = mock(() => {});
      writeln = mock(() => {});
      write = mock(() => {});
    },
  },
}));

mock.module('@xterm/addon-fit', () => ({
  default: {
    FitAddon: class MockFitAddon {
      fit = mock(() => {});
      dispose = mock(() => {});
    },
  },
}));

// Mock xterm.js CSS import
mock.module('@xterm/xterm/css/xterm.css', () => ({}));

// Mock useContainerLogs
let mockReturnValue = { isConnected: false, error: null as Error | null };

mock.module('@/hooks/useContainerLogs', () => ({
  useContainerLogs: (opts: { containerId: string; host: string }) => {
    lastCallOpts = opts;
    return mockReturnValue;
  },
}));

let lastCallOpts: { containerId: string; host: string } | null = null;

const { default: ContainerLogViewer } = await import('../ContainerLogViewer');

describe('ContainerLogViewer', () => {
  it('renders logs title', () => {
    mockReturnValue = { isConnected: true, error: null };
    render(<ContainerLogViewer containerId="abc123" host="server" />);
    expect(screen.getByText('Logs')).toBeTruthy();
  });

  it('shows connecting overlay when not connected', () => {
    mockReturnValue = { isConnected: false, error: null };
    render(<ContainerLogViewer containerId="abc123" host="server" />);
    expect(screen.getByText('Connecting...')).toBeTruthy();
  });

  it('hides connecting overlay when connected', () => {
    mockReturnValue = { isConnected: true, error: null };
    render(<ContainerLogViewer containerId="abc123" host="server" />);
    expect(screen.queryByText('Connecting...')).toBeNull();
  });

  it('shows error message on failure', () => {
    mockReturnValue = {
      isConnected: false,
      error: new Error('Connection refused'),
    };
    render(<ContainerLogViewer containerId="abc123" host="server" />);
    expect(screen.getByText('Connection refused')).toBeTruthy();
  });

  it('passes correct props to useContainerLogs', () => {
    mockReturnValue = { isConnected: true, error: null };
    lastCallOpts = null;
    render(<ContainerLogViewer containerId="my-container" host="my-host" />);
    expect(lastCallOpts).not.toBeNull();
    expect(lastCallOpts!.containerId).toBe('my-container');
    expect(lastCallOpts!.host).toBe('my-host');
  });
});

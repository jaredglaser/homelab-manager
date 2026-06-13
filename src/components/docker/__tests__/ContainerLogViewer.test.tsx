import { describe, it, expect, mock, afterAll } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';

// Track mock terminal instances for lifecycle testing
const mockTerminalInstances: { dispose: ReturnType<typeof mock>; loadAddon: ReturnType<typeof mock>; open: ReturnType<typeof mock> }[] = [];

// Mock xterm.js - CJS modules need default export for bun:test ESM loader
mock.module('@xterm/xterm', () => ({
  default: {
    Terminal: class MockTerminal {
      disableStdin = true;
      loadAddon = mock(() => {});
      open = mock(() => {});
      dispose = mock(() => {});
      writeln = mock(() => {});
      write = mock(() => {});
      resize = mock(() => {});
      onLineFeed = mock(() => ({ dispose: mock(() => {}) }));
      onWriteParsed = mock(() => ({ dispose: mock(() => {}) }));
      cols = 80;
      rows = 24;
      buffer = { active: { length: 0, getLine: () => null, viewportY: 0, cursorY: 0 } };
      constructor() {
        mockTerminalInstances.push(this as unknown as typeof mockTerminalInstances[0]);
      }
    },
  },
}));

// Track fit calls
const mockFitFn = mock(() => {});

mock.module('@xterm/addon-fit', () => ({
  default: {
    FitAddon: class MockFitAddon {
      fit = mockFitFn;
      dispose = mock(() => {});
      activate = mock(() => {});
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

// Mock ResizeObserver
let lastResizeCallback: (() => void) | null = null;
const mockObserve = mock(() => {});
const mockDisconnect = mock(() => {});

class MockResizeObserver {
  constructor(callback: () => void) {
    lastResizeCallback = callback;
  }
  observe = mockObserve;
  disconnect = mockDisconnect;
  unobserve = mock(() => {});
}

const originalResizeObserver = (globalThis as unknown as { ResizeObserver: typeof MockResizeObserver }).ResizeObserver;
(globalThis as unknown as { ResizeObserver: typeof MockResizeObserver }).ResizeObserver = MockResizeObserver;

afterAll(() => {
  (globalThis as unknown as { ResizeObserver: typeof MockResizeObserver }).ResizeObserver = originalResizeObserver;
});

const { default: ContainerLogViewer } = await import('../ContainerLogViewer');

describe('ContainerLogViewer', () => {
  it('shows skeleton loading state when not ready', () => {
    mockReturnValue = { isConnected: false, error: null };
    const { container } = render(<ContainerLogViewer containerId="abc123" host="server" wordWrap={false} />);
    // Skeleton elements should be present
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    // Terminal container should be invisible (opacity-0)
    const termContainer = container.querySelector('.transition-opacity');
    expect(termContainer?.className).toContain('opacity-0');
  });

  it('hides skeleton when connected with terminal', async () => {
    mockReturnValue = { isConnected: true, error: null };
    mockTerminalInstances.length = 0;
    const { container } = render(<ContainerLogViewer containerId="abc123" host="server" wordWrap={false} />);

    // Wait for terminal to initialize (triggers ready state)
    await waitFor(() => {
      expect(mockTerminalInstances.length).toBeGreaterThan(0);
    });

    // Once ready, skeleton should be gone and terminal visible
    await waitFor(() => {
      expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(0);
      const termContainer = container.querySelector('.transition-opacity');
      expect(termContainer?.className).toContain('opacity-100');
    });
  });

  it('shows error message on failure', () => {
    mockReturnValue = {
      isConnected: false,
      error: new Error('Connection refused'),
    };
    render(<ContainerLogViewer containerId="abc123" host="server" wordWrap={false} />);
    expect(screen.getByText('Connection refused')).toBeTruthy();
  });

  it('passes correct props to useContainerLogs', () => {
    mockReturnValue = { isConnected: true, error: null };
    lastCallOpts = null;
    render(<ContainerLogViewer containerId="my-container" host="my-host" wordWrap={false} />);
    expect(lastCallOpts).not.toBeNull();
    expect(lastCallOpts!.containerId).toBe('my-container');
    expect(lastCallOpts!.host).toBe('my-host');
  });

  it('initializes terminal and calls dispose on unmount', async () => {
    mockReturnValue = { isConnected: true, error: null };
    mockTerminalInstances.length = 0;

    const { unmount } = render(<ContainerLogViewer containerId="abc123" host="server" wordWrap={false} />);

    // Wait for async terminal initialization
    await waitFor(() => {
      expect(mockTerminalInstances.length).toBeGreaterThan(0);
    });

    const term = mockTerminalInstances[mockTerminalInstances.length - 1];
    expect(term.open).toHaveBeenCalled();

    // Unmount should dispose the terminal
    unmount();
    expect(term.dispose).toHaveBeenCalled();
  });

  it('sets up ResizeObserver after terminal init', async () => {
    mockReturnValue = { isConnected: true, error: null };
    mockTerminalInstances.length = 0;
    mockObserve.mockClear();
    mockFitFn.mockClear();
    lastResizeCallback = null;

    render(<ContainerLogViewer containerId="abc123" host="server" wordWrap={false} />);

    // Wait for async terminal initialization which triggers re-render
    await waitFor(() => {
      expect(mockTerminalInstances.length).toBeGreaterThan(0);
    });

    // ResizeObserver should be set up after terminal state update
    await waitFor(() => {
      expect(mockObserve).toHaveBeenCalled();
    });

    // Simulate a resize event - should call fit without error
    const cb = lastResizeCallback as (() => void) | null;
    if (cb) {
      cb();
    }
  });
});

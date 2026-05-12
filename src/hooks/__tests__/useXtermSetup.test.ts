import { describe, it, expect, mock, afterAll } from 'bun:test';
import { renderHook, waitFor } from '@testing-library/react';

interface MockTerminalInstance {
  options: Record<string, unknown>;
  dispose: ReturnType<typeof mock>;
  loadAddon: ReturnType<typeof mock>;
  open: ReturnType<typeof mock>;
}

const mockTerminalInstances: MockTerminalInstance[] = [];

mock.module('@xterm/xterm', () => ({
  default: {
    Terminal: class MockTerminal {
      options: Record<string, unknown> = {};
      loadAddon = mock(() => {});
      open = mock(() => {});
      dispose = mock(() => {});
      constructor(opts: Record<string, unknown>) {
        this.options = opts ?? {};
        mockTerminalInstances.push(this as unknown as typeof mockTerminalInstances[0]);
      }
    },
  },
}));

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

mock.module('@xterm/xterm/css/xterm.css', () => ({}));

const mockObserve = mock(() => {});
const mockDisconnect = mock(() => {});

class MockResizeObserver {
  constructor(_cb: () => void) {}
  observe = mockObserve;
  disconnect = mockDisconnect;
  unobserve = mock(() => {});
}

const originalResizeObserver = (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver;
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;

afterAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = originalResizeObserver;
});

const { useXtermSetup } = await import('@/hooks/useXtermSetup');

describe('useXtermSetup', () => {
  it('initializes terminal and returns it after mount', async () => {
    mockTerminalInstances.length = 0;
    const { result } = renderHook(() => useXtermSetup({ disableStdin: true }));
    await waitFor(() => expect(result.current.terminal).not.toBeNull());
    expect(mockTerminalInstances.length).toBe(1);
  });

  it('disposes terminal on unmount', async () => {
    mockTerminalInstances.length = 0;
    const { result, unmount } = renderHook(() => useXtermSetup({}));
    await waitFor(() => expect(result.current.terminal).not.toBeNull());
    const term = mockTerminalInstances[mockTerminalInstances.length - 1];
    unmount();
    expect(term.dispose).toHaveBeenCalled();
  });

  it('does not register ResizeObserver when container ref is not attached', async () => {
    // In renderHook with no DOM, containerRef.current stays null, the observer
    // effect returns early, and observe is never called. The component path
    // (where <div ref={containerRef}> populates the ref) is exercised indirectly
    // by the ContainerTerminal tests.
    mockTerminalInstances.length = 0;
    mockObserve.mockClear();
    const { result } = renderHook(() => useXtermSetup({}));
    await waitFor(() => expect(result.current.terminal).not.toBeNull());
    expect(result.current.containerRef).toBeTruthy();
    expect(mockObserve).not.toHaveBeenCalled();
  });

  it('passes provided options to Terminal constructor', async () => {
    mockTerminalInstances.length = 0;
    renderHook(() => useXtermSetup({ disableStdin: false, cursorBlink: true }));
    await waitFor(() => expect(mockTerminalInstances.length).toBeGreaterThan(0));
    expect(mockTerminalInstances[0]!.options).toMatchObject({ disableStdin: false, cursorBlink: true });
  });
});

import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { DockerInventorySnapshotContainer } from '@/types/docker-inventory';

mock.module('@/components/docker/ContainerLogViewer', () => ({
  default: ({ containerId }: { containerId: string }) => (
    <div data-testid="log-viewer">{containerId}</div>
  ),
}));

mock.module('@/components/docker/ContainerTerminal', () => ({
  default: ({ frozen }: { frozen: boolean }) => (
    <div data-testid="terminal" data-frozen={String(frozen)} />
  ),
}));

const mockGetContainerShell = mock(() => undefined as string | undefined);
const mockSetContainerShell = mock(() => {});

mock.module('@/hooks/useDockerSettings', () => ({
  useDockerSettings: () => ({
    getContainerShell: mockGetContainerShell,
    setContainerShell: mockSetContainerShell,
  }),
}));

const runningInventory: DockerInventorySnapshotContainer = {
  host: 'server1',
  containerId: 'abc123',
  name: 'nginx',
  image: 'nginx:latest',
  state: 'running',
  composeProject: null,
  serviceKey: 'nginx',
  startedAt: new Date(),
  finishedAt: null,
  exitCode: null,
  labels: {},
  updatedAt: new Date(),
};

const stoppedInventory: DockerInventorySnapshotContainer = {
  ...runningInventory,
  state: 'exited',
};

function renderPanel(inventory = runningInventory) {
  const store = createStore();
  return render(
    <Provider store={store}>
      <ContainerLogsTerminalPanel containerId="abc123" host="server1" inventory={inventory} />
    </Provider>,
  );
}

const { default: ContainerLogsTerminalPanel } = await import('../ContainerLogsTerminalPanel');

describe('ContainerLogsTerminalPanel', () => {
  it('shows Logs tab active by default', () => {
    renderPanel();
    const logsTab = screen.getByRole('tab', { name: /logs/i });
    expect(logsTab.getAttribute('aria-selected')).toBe('true');
  });

  it('renders log viewer by default', () => {
    renderPanel();
    expect(screen.getByTestId('log-viewer')).toBeTruthy();
  });

  it('Terminal tab is disabled when container is not running', () => {
    renderPanel(stoppedInventory);
    const termTab = screen.getByRole('tab', { name: /terminal/i });
    expect(termTab.hasAttribute('disabled')).toBe(true);
  });

  it('Terminal tab is enabled when container is running', () => {
    renderPanel(runningInventory);
    const termTab = screen.getByRole('tab', { name: /terminal/i });
    expect(termTab.hasAttribute('disabled')).toBe(false);
  });

  it('clicking Terminal tab mounts and shows terminal component', () => {
    renderPanel(runningInventory);
    fireEvent.click(screen.getByRole('tab', { name: /terminal/i }));
    expect(screen.getByTestId('terminal')).toBeTruthy();
  });

  it('shell selector visible only on Terminal tab', () => {
    renderPanel(runningInventory);
    expect(screen.queryByLabelText(/shell/i)).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /terminal/i }));
    expect(screen.getByLabelText(/shell/i)).toBeTruthy();
  });

  it('frozen=true passed to terminal when container stops mid-session', () => {
    // Must reuse the same store on rerender; a new <Provider store={...}>
    // would remount the panel and lose the `terminalMounted` local state
    // set by the click, defeating the test.
    const store = createStore();
    const { rerender } = render(
      <Provider store={store}>
        <ContainerLogsTerminalPanel containerId="abc123" host="server1" inventory={runningInventory} />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('tab', { name: /terminal/i }));

    rerender(
      <Provider store={store}>
        <ContainerLogsTerminalPanel containerId="abc123" host="server1" inventory={stoppedInventory} />
      </Provider>,
    );

    const terminal = screen.getByTestId('terminal');
    expect(terminal.getAttribute('data-frozen')).toBe('true');
  });
});

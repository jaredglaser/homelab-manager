import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { DockerInventorySnapshotContainer } from '@/types/docker-inventory';

mock.module('@/components/docker/ContainerLogViewer', () => ({
  default: ({ containerId }: { containerId: string }) => (
    <div data-testid="log-viewer">{containerId}</div>
  ),
}));

// Each render of the mocked ContainerTerminal stamps a unique instance id so
// tests can prove the same React node persisted (not unmounted/remounted)
// across tab switches.
let __nextTerminalInstanceId = 0;
mock.module('@/components/docker/ContainerTerminal', () => {
  function MockContainerTerminal({ frozen, shell }: { frozen: boolean; shell: string }) {
    // useState seed runs once per mounted component instance; if the panel
    // remounts ContainerTerminal on tab switch, this id will change.
    const [id] = useState(() => {
      __nextTerminalInstanceId += 1;
      return `term-${__nextTerminalInstanceId}`;
    });
    return (
      <div
        data-testid="terminal"
        data-frozen={String(frozen)}
        data-shell={shell}
        data-instance-id={id}
      />
    );
  }
  return { default: MockContainerTerminal };
});

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

const { default: ContainerLogsTerminalPanel } = await import('@/components/docker/ContainerLogsTerminalPanel');

describe('ContainerLogsTerminalPanel', () => {
  beforeEach(() => {
    mockGetContainerShell.mockReturnValue(undefined);
    mockSetContainerShell.mockClear();
    __nextTerminalInstanceId = 0;
  });

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

  it('keeps ContainerTerminal mounted across Logs<->Terminal tab switches', () => {
    // The panel uses CSS hiding (className 'hidden') rather than conditional
    // mounting so xterm's scrollback survives tab switches. A regression to
    // {tab === 'terminal' && <ContainerTerminal/>} would unmount the terminal,
    // dropping its instance id between visits.
    renderPanel(runningInventory);
    fireEvent.click(screen.getByRole('tab', { name: /terminal/i }));
    const firstId = screen.getByTestId('terminal').getAttribute('data-instance-id');
    expect(firstId).toBeTruthy();

    // Logs -> Terminal -> Logs -> Terminal: instance id must remain constant.
    fireEvent.click(screen.getByRole('tab', { name: /logs/i }));
    fireEvent.click(screen.getByRole('tab', { name: /terminal/i }));
    fireEvent.click(screen.getByRole('tab', { name: /logs/i }));
    fireEvent.click(screen.getByRole('tab', { name: /terminal/i }));

    const finalId = screen.getByTestId('terminal').getAttribute('data-instance-id');
    expect(finalId).toBe(firstId);
  });

  it('calls setContainerShell with the correct key when shell selector changes', () => {
    renderPanel(runningInventory);
    fireEvent.click(screen.getByRole('tab', { name: /terminal/i }));
    // Open the Select and pick 'bash'
    fireEvent.mouseDown(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: 'bash' }));
    // shellKey is `${host}/${inventory.name}` = 'server1/nginx'
    expect(mockSetContainerShell).toHaveBeenCalledWith('server1/nginx', 'bash');
  });

  it('passes saved shell preference as effectiveShell to ContainerTerminal', () => {
    mockGetContainerShell.mockReturnValue('bash');
    renderPanel(runningInventory);
    fireEvent.click(screen.getByRole('tab', { name: /terminal/i }));
    const terminal = screen.getByTestId('terminal');
    expect(terminal.getAttribute('data-shell')).toBe('bash');
  });

  it('renders terminal immediately when defaultTab is "terminal"', () => {
    const store = createStore();
    render(
      <Provider store={store}>
        <ContainerLogsTerminalPanel
          containerId="abc123"
          host="server1"
          inventory={runningInventory}
          defaultTab="terminal"
        />
      </Provider>,
    );
    expect(screen.getByTestId('terminal')).toBeTruthy();
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

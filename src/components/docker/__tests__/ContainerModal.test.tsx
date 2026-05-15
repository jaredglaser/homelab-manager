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
  default: ({ shell, frozen }: { shell: string; frozen: boolean }) => (
    <div data-testid="terminal" data-shell={shell} data-frozen={String(frozen)} />
  ),
}));

mock.module('@/components/docker/ContainerHistoryPage', () => ({
  default: () => <div data-testid="history-page" />,
}));

mock.module('@/components/docker/ContainerStateChip', () => ({
  default: ({ state }: { state: string }) => <span data-testid="state-chip">{state}</span>,
}));

mock.module('@/lib/utils/icon-resolver', () => ({
  getIconUrl: (_slug: string | null, image: string) => `https://icons.example.com/${image}.png`,
  FALLBACK_ICON_URL: 'https://icons.example.com/fallback.png',
  AVAILABLE_ICONS: [],
}));

const mockGetContainerShell = mock(() => undefined as string | undefined);
const mockSetContainerShell = mock(() => {});

mock.module('@/hooks/useDockerSettings', () => ({
  useDockerSettings: () => ({
    docker: { chartWindowSeconds: 300 },
    getContainerShell: mockGetContainerShell,
    setContainerShell: mockSetContainerShell,
  }),
}));

const { default: ContainerModal } = await import('@/components/docker/ContainerModal');

const runningInventory: DockerInventorySnapshotContainer = {
  host: 'server1',
  containerId: 'abc123def456',
  name: 'nginx',
  image: 'nginx:latest',
  state: 'running',
  composeProject: null,
  serviceKey: 'nginx',
  startedAt: new Date('2024-01-01T00:00:00Z'),
  finishedAt: null,
  exitCode: null,
  labels: {},
  updatedAt: new Date('2024-01-01T00:00:00Z'),
};

const stoppedInventory: DockerInventorySnapshotContainer = {
  ...runningInventory,
  state: 'exited',
  finishedAt: new Date('2024-01-01T01:00:00Z'),
  exitCode: 0,
};

function renderModal(props: Partial<Parameters<typeof ContainerModal>[0]> = {}) {
  const store = createStore();
  return render(
    <Provider store={store}>
      <ContainerModal
        open={true}
        onClose={() => {}}
        containerId="abc123def456"
        host="server1"
        inventory={runningInventory}
        {...props}
      />
    </Provider>,
  );
}

describe('ContainerModal', () => {
  it('renders nothing visible when closed', () => {
    renderModal({ open: false });
    expect(screen.queryByTestId('log-viewer')).toBeNull();
  });

  it('renders log viewer on logs tab by default', () => {
    renderModal();
    screen.getByTestId('log-viewer');
  });

  it('renders with null inventory (no header)', () => {
    renderModal({ inventory: null });
    expect(screen.queryByTestId('state-chip')).toBeNull();
    // Log viewer still rendered
    screen.getByTestId('log-viewer');
  });

  it('renders container name and short id in header', () => {
    renderModal();
    screen.getByText('nginx');
    screen.getByText(/abc123def456/i);
  });

  it('renders state chip for running container', () => {
    renderModal();
    screen.getByTestId('state-chip');
    screen.getByText('running');
  });

  it('shows Logs, Terminal, History tab buttons', () => {
    renderModal();
    screen.getByText('Logs');
    screen.getByText('Terminal');
    screen.getByText('History');
  });

  it('terminal tab is disabled for stopped container', () => {
    renderModal({ inventory: stoppedInventory });
    const terminalBtn = screen.getByText('Terminal').closest('button')!;
    expect(terminalBtn.disabled).toBe(true);
  });

  it('terminal tab is enabled for running container', () => {
    renderModal();
    const terminalBtn = screen.getByText('Terminal').closest('button')!;
    expect(terminalBtn.disabled).toBe(false);
  });

  it('switches to history tab and renders history page', () => {
    renderModal();
    fireEvent.click(screen.getByText('History'));
    screen.getByTestId('history-page');
  });

  it('switches to logs tab from history', () => {
    renderModal({ initialTab: 'history' });
    screen.getByTestId('history-page');
    fireEvent.click(screen.getByText('Logs'));
    screen.getByTestId('log-viewer');
  });

  it('switching to terminal tab mounts terminal', () => {
    renderModal();
    expect(screen.queryByTestId('terminal')).toBeNull();
    fireEvent.click(screen.getByText('Terminal'));
    screen.getByTestId('terminal');
  });

  it('terminal stays mounted after switching back to logs', () => {
    renderModal();
    fireEvent.click(screen.getByText('Terminal'));
    fireEvent.click(screen.getByText('Logs'));
    // terminal is hidden but still mounted
    expect(screen.getByTestId('terminal')).toBeTruthy();
  });

  it('opens on history tab when initialTab is history', () => {
    renderModal({ initialTab: 'history' });
    screen.getByTestId('history-page');
    // log viewer stays mounted but is hidden via CSS
    screen.getByTestId('log-viewer');
  });

  it('calls onClose when close button is clicked', () => {
    let closed = false;
    renderModal({ onClose: () => { closed = true; } });
    fireEvent.click(screen.getByLabelText('Close modal'));
    expect(closed).toBe(true);
  });

  it('passes containerId to log viewer', () => {
    renderModal();
    expect(screen.getByTestId('log-viewer').textContent).toBe('abc123def456');
  });

  it('terminal is not mounted before the terminal tab is visited', () => {
    renderModal({ inventory: stoppedInventory });
    // Terminal tab is disabled for stopped containers and never clicked
    expect(screen.queryByTestId('terminal')).toBeNull();
  });

  it('terminal receives frozen=false for running container', () => {
    renderModal();
    fireEvent.click(screen.getByText('Terminal'));
    const terminal = screen.getByTestId('terminal');
    expect(terminal.getAttribute('data-frozen')).toBe('false');
  });

  it('renders an icon image in the header', () => {
    renderModal({ iconSlug: null });
    const img = document.querySelector('img.w-6');
    expect(img?.getAttribute('src')).toBeTruthy();
  });
});

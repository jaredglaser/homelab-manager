import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import type { DockerInventorySnapshotContainer } from '@/types/docker-inventory';

mock.module('@/components/docker/ContainerLogViewer', () => ({
  default: ({ containerId }: { containerId: string }) => (
    <div data-testid="log-viewer" data-container-id={containerId} />
  ),
}));

mock.module('@/components/docker/ContainerTerminal', () => ({
  default: () => <div data-testid="terminal" />,
}));

mock.module('@/components/docker/ContainerHistoryPage', () => ({
  default: () => <div data-testid="history-page" />,
}));

mock.module('@/components/docker/ContainerActionButtons', () => ({
  default: () => null,
}));

mock.module('@/hooks/useDockerSettings', () => ({
  useDockerSettings: () => ({
    getContainerShell: () => undefined,
    setContainerShell: () => {},
  }),
}));

mock.module('@/lib/utils/icon-resolver', () => ({
  getIconUrl: () => 'http://icons/nginx.png',
  FALLBACK_ICON_URL: 'http://icons/fallback.png',
}));

const { default: ContainerModal } = await import('@/components/docker/ContainerModal');
const { createStore, Provider } = await import('jotai');

const sampleInventory: DockerInventorySnapshotContainer = {
  host: 'server',
  containerId: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc123',
  name: 'nginx-proxy',
  image: 'nginx:latest',
  state: 'running',
  composeProject: null,
  serviceKey: 'nginx-proxy',
  startedAt: new Date('2024-01-01T00:00:00Z'),
  finishedAt: null,
  exitCode: null,
  labels: {},
  updatedAt: new Date('2024-01-01T00:00:00Z'),
};

function renderModal(props: Partial<Parameters<typeof ContainerModal>[0]> = {}) {
  const store = createStore();
  return render(
    <Provider store={store}>
      <ContainerModal
        open
        onClose={() => {}}
        containerId="abc123"
        host="server"
        inventory={sampleInventory}
        {...props}
      />
    </Provider>,
  );
}

describe('ContainerModal', () => {
  it('renders the container name in the header', () => {
    renderModal();
    screen.getByText('nginx-proxy');
  });

  it('shows the log viewer by default', () => {
    renderModal();
    expect(screen.getByTestId('log-viewer')).toBeDefined();
  });

  it('passes containerId to the log viewer', () => {
    renderModal();
    expect(screen.getByTestId('log-viewer').dataset.containerId).toBe('abc123');
  });

  it('opens on the correct tab when initialTab="history"', () => {
    renderModal({ initialTab: 'history' });
    // history-page is visible; log-viewer is always mounted but CSS-hidden
    expect(screen.getByTestId('history-page')).toBeDefined();
    expect(screen.getByTestId('log-viewer').closest('.hidden')).toBeDefined();
  });

  it('shows the history tab content when History tab is clicked', () => {
    renderModal();
    fireEvent.click(screen.getByText('History'));
    expect(screen.getByTestId('history-page')).toBeDefined();
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = mock(() => {});
    renderModal({ onClose });
    fireEvent.click(screen.getByLabelText('Close modal'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the state chip', () => {
    renderModal();
    screen.getByText('running');
  });

  it('shows the terminal tab as disabled when container is not running', () => {
    renderModal({ inventory: { ...sampleInventory, state: 'exited' } });
    const terminalBtn = screen.getByText('Terminal').closest('button') as HTMLButtonElement;
    expect(terminalBtn.disabled).toBe(true);
  });
});

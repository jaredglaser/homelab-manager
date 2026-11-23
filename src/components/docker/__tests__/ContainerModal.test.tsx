import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { findOpenTooltip, roleReasonOf, seedSession } from '@/lib/test/session';
import { setupUser } from '@/lib/test/user-event';
import { VIEWER_DENIED_COPY } from '@/hooks/useAuth';
import { render, screen, fireEvent } from '@testing-library/react';
import type { DockerInventorySnapshotContainer } from '@/types/docker-inventory';
import { mockModule } from '@/lib/test/mock-module';

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

mockModule<typeof import('@/hooks/useDockerSettings')>('@/hooks/useDockerSettings', (real) => ({ ...real, 
  useDockerSettings: () => ({
    getContainerShell: () => undefined,
    setContainerShell: () => {},
  }),
}));

mockModule<typeof import('@/lib/utils/icon-resolver')>('@/lib/utils/icon-resolver', (real) => ({ ...real, 
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
  imageDigest: null,
  state: 'running',
  composeProject: null,
  serviceKey: 'nginx-proxy',
  startedAt: new Date('2024-01-01T00:00:00Z'),
  finishedAt: null,
  exitCode: null,
  labels: {},
  ports: [],
  mounts: [],
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

beforeEach(() => {
  seedSession('admin');
});

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

  it('shows a viewer the Terminal tab disabled with the role reason, and a click opens no terminal', async () => {
    seedSession('viewer');
    renderModal();
    const user = setupUser();
    const terminal = screen.getByRole('button', { name: 'Terminal' });
    expect(terminal.getAttribute('aria-disabled')).toBe('true');
    expect(roleReasonOf(terminal)).toBe(VIEWER_DENIED_COPY);
    fireEvent.click(terminal);
    await user.hover(terminal);
    expect(await findOpenTooltip()).toBe(VIEWER_DENIED_COPY);
    expect(screen.queryByTestId('terminal')).toBeNull();
    expect(screen.getByTestId('log-viewer').closest('.hidden')).toBeNull();
  });

  it('opens a viewer on Logs when asked for the terminal tab', () => {
    seedSession('viewer');
    renderModal({ initialTab: 'terminal' });
    expect(screen.queryByTestId('terminal')).toBeNull();
    expect(screen.getByTestId('log-viewer').closest('.hidden')).toBeNull();
  });

  it.each(['admin', 'operator'] as const)('lets an %s open the Terminal tab', async (role) => {
    seedSession(role);
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
    expect(await screen.findByTestId('terminal')).toBeDefined();
  });

  it('shows the terminal tab as disabled when container is not running', () => {
    renderModal({ inventory: { ...sampleInventory, state: 'exited' } });
    const terminalBtn = screen.getByText('Terminal').closest('button') as HTMLButtonElement;
    expect(terminalBtn.disabled).toBe(true);
  });
});

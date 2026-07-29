import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
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

  it('sizes the dialog full-bleed by default, constrained to the desktop card at lg', () => {
    renderModal();
    const content = document.querySelector('[data-slot="dialog-content"]') as HTMLElement;
    expect(content.className).toContain('w-full');
    expect(content.className).toContain('h-full');
    expect(content.className).toContain('rounded-none');
    expect(content.className).toContain('lg:w-[calc(100%-64px)]');
    expect(content.className).toContain('lg:h-[calc(100vh-80px)]');
    expect(content.className).toContain('lg:rounded-lg');
  });
});

function installMatchMedia(matches: (query: string) => boolean) {
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: matches(query),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
  });
}

describe('ContainerModal below the lg breakpoint', () => {
  installMatchMedia((query) => query === '(max-width: 1023px)');

  it('keeps the close button reachable next to the identity row instead of the crowded actions row', () => {
    const onClose = mock(() => {});
    renderModal({ onClose });
    fireEvent.click(screen.getByLabelText('Close modal'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('still switches tabs once the header stacks into rows', () => {
    renderModal();
    fireEvent.click(screen.getByText('History'));
    expect(screen.getByTestId('history-page')).toBeDefined();
  });

  it('keeps the word wrap toggle reachable', () => {
    renderModal();
    expect(screen.getByLabelText('Toggle word wrap')).toBeDefined();
  });
});

describe('ContainerModal on touch devices', () => {
  installMatchMedia((query) => query === '(hover: none), (pointer: coarse)');

  it('expands the close button hit area via tap-target without changing its painted size', () => {
    renderModal();
    expect(screen.getByLabelText('Close modal').className).toContain('tap-target');
  });

  it('expands the tab pills hit area via tap-target', () => {
    renderModal();
    const logsTab = screen.getByText('Logs').closest('button') as HTMLButtonElement;
    expect(logsTab.className).toContain('tap-target');
  });
});

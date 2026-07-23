import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import type { StackContainer } from '@/types/stacks';

// Tooltip open state is Base UI's own hover/delay machinery, not this component's
// logic; mock it to render children unconditionally so tests assert on content, not
// on simulating pointer hover through happy-dom.
mock.module('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render: el }: { render: ReactElement }) => el,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

const mockControlStack = mock(async () => {});

const mockToastSuccess = mock((_message: string) => {});
const mockToastError = mock((_message: string) => {});

mock.module('sonner', () => ({
  toast: { success: mockToastSuccess, error: mockToastError },
}));

mock.module('@/data/stacks/functions', () => ({
  controlStack: mockControlStack,
}));

mock.module('@/components/docker/ContainerLogViewer', () => ({
  default: ({ containerId }: { containerId: string }) => (
    <div data-testid="log-viewer">{containerId}</div>
  ),
}));

mock.module('@/components/docker/ContainerTerminal', () => ({
  default: ({ containerId, frozen }: { containerId: string; frozen: boolean }) => (
    <div data-testid="terminal-viewer" data-frozen={String(frozen)}>{containerId}</div>
  ),
}));

mock.module('@/hooks/useDockerSettings', () => ({
  useDockerSettings: () => ({
    getContainerShell: () => undefined,
    setContainerShell: () => {},
  }),
}));

mock.module('@/lib/constants/demo', () => ({ IS_DEMO_MODE: false }));

const { default: StackContainersPanel } = await import('@/components/stacks/StackContainersPanel');

const mockContainers: StackContainer[] = [
  { id: 'abc123', name: 'plex-web-1', status: 'running', image: 'plexinc/pms-docker', service: 'web', ports: [], mounts: [] },
  { id: 'def456', name: 'plex-db-1', status: 'exited', image: 'postgres:16', service: 'db', ports: [], mounts: [] },
];

const defaultProps = {
  containers: mockContainers,
  stackName: 'plex',
  host: 'server1',
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function renderPanel(props = defaultProps) {
  return render(<StackContainersPanel {...props} />, { wrapper: createWrapper() });
}

describe('StackContainersPanel', () => {
  beforeEach(() => {
    mockControlStack.mockClear();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });

  it('renders container names and statuses', () => {
    renderPanel();
    expect(screen.getByText('plex-web-1')).toBeDefined();
    expect(screen.getByText('running')).toBeDefined();
    expect(screen.getByText('plex-db-1')).toBeDefined();
    expect(screen.getByText('exited')).toBeDefined();
  });

  it('renders stack-level Start, Stop, Restart buttons', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: /^start$/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /^stop$/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /^restart$/i })).toBeDefined();
  });

  it('calls controlStack with scope:stack when stack-level Start is clicked', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /^start$/i }));
    await waitFor(() => expect(mockControlStack).toHaveBeenCalledTimes(1));
    const firstCall = (mockControlStack.mock.calls as unknown as { data: Record<string, unknown> }[][])[0][0];
    expect(firstCall.data.action).toBe('start');
    expect(firstCall.data.scope).toBe('stack');
    expect(firstCall.data.stack).toBe('plex');
    expect(firstCall.data.host).toBe('server1');
  });

  it('calls controlStack with scope:service when per-service restart is clicked', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /^restart web$/i }));
    await waitFor(() => expect(mockControlStack).toHaveBeenCalledTimes(1));
    const firstCall = (mockControlStack.mock.calls as unknown as { data: Record<string, unknown> }[][])[0][0];
    expect(firstCall.data.action).toBe('restart');
    expect(firstCall.data.scope).toBe('service');
    expect(firstCall.data.service).toBe('web');
  });

  it('shows empty state when no containers', () => {
    renderPanel({ ...defaultProps, containers: [] });
    expect(screen.getByText(/no containers/i)).toBeDefined();
  });

  it('opens log modal when Logs button is clicked', () => {
    renderPanel();
    const logsBtn = screen.getAllByRole('button', { name: /^logs$/i })[0];
    fireEvent.click(logsBtn);
    expect(screen.getByTestId('log-viewer')).toBeDefined();
    expect(screen.getByTestId('log-viewer').textContent).toBe('abc123');
  });

  it('opens terminal modal when Terminal button is clicked', () => {
    renderPanel();
    const terminalBtn = screen.getAllByRole('button', { name: /^terminal$/i })[0];
    fireEvent.click(terminalBtn);
    expect(screen.getByTestId('terminal-viewer')).toBeDefined();
    expect(screen.getByTestId('terminal-viewer').textContent).toBe('abc123');
  });

  it('closes log modal when close button is clicked', () => {
    renderPanel();
    fireEvent.click(screen.getAllByRole('button', { name: /^logs$/i })[0]);
    expect(screen.getByTestId('log-viewer')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(screen.queryByTestId('log-viewer')).toBeNull();
  });

  it('shows error toast when controlStack rejects', async () => {
    mockControlStack.mockRejectedValueOnce(new Error('agent unreachable'));
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /^start$/i }));
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    const message = mockToastError.mock.calls[0][0];
    expect(message).toContain('Failed to start');
    expect(message).toContain('agent unreachable');
  });

  it('shows success toast with past-tense message when controlStack resolves', async () => {
    mockControlStack.mockResolvedValueOnce(undefined);
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /^start$/i }));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
    const message = mockToastSuccess.mock.calls[0][0];
    expect(message).toContain('plex');
    expect(message).toContain('started');
    expect(message).toContain('successfully');
  });

  it('disables all control buttons while mutation is pending', async () => {
    let resolveControl!: () => void;
    mockControlStack.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveControl = resolve; })
    );
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /^start$/i }));

    await waitFor(() => {
      ['Start', 'Stop', 'Restart',
        'Start web', 'Stop web', 'Restart web',
        'Start db', 'Stop db', 'Restart db',
      ].forEach((label) => {
        expect(screen.getByRole('button', { name: label })).toHaveProperty('disabled', true);
      });
    });

    resolveControl();
  });

  it('disables stack-level buttons when containers list is empty', () => {
    renderPanel({ ...defaultProps, containers: [] });
    expect(screen.getByRole('button', { name: 'Start' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Stop' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Restart' })).toHaveProperty('disabled', true);
  });

  it('passes frozen=false to ContainerTerminal for a running container', () => {
    renderPanel();
    fireEvent.click(screen.getAllByRole('button', { name: /^terminal$/i })[0]);
    expect(screen.getByTestId('terminal-viewer').getAttribute('data-frozen')).toBe('false');
  });

  it('passes frozen=true to ContainerTerminal for a stopped container', () => {
    renderPanel();
    fireEvent.click(screen.getAllByRole('button', { name: /^terminal$/i })[1]);
    expect(screen.getByTestId('terminal-viewer').getAttribute('data-frozen')).toBe('true');
  });

  it('hides per-service control buttons when service is null', () => {
    const containersWithNullService: StackContainer[] = [
      { id: 'xyz789', name: 'orphan-1', status: 'running', image: 'alpine', service: null, ports: [], mounts: [] },
    ];
    renderPanel({ ...defaultProps, containers: containersWithNullService });
    expect(screen.queryByRole('button', { name: /^start orphan/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^stop orphan/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^restart orphan/i })).toBeNull();
  });

  it('renders port chips after the image, deduped and dimmed for unpublished ports', () => {
    const containersWithPorts: StackContainer[] = [
      {
        id: 'abc123',
        name: 'plex-web-1',
        status: 'running',
        image: 'plexinc/pms-docker',
        service: 'web',
        ports: [
          { containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 8080 },
          { containerPort: 80, protocol: 'tcp', hostIp: '::', hostPort: 8080 },
          { containerPort: 9000, protocol: 'tcp', hostIp: null, hostPort: null },
        ],
        mounts: [],
      },
    ];
    renderPanel({ ...defaultProps, containers: containersWithPorts });

    const published = screen.getByText('8080->80/tcp');
    const unpublished = screen.getByText('9000/tcp');
    expect(published.className).not.toContain('muted-foreground');
    expect(unpublished.className).toContain('muted-foreground');
  });

  it('renders a mounts icon whose tooltip lists source -> destination, with [ro] for read-only mounts', () => {
    const containersWithMounts: StackContainer[] = [
      {
        id: 'abc123',
        name: 'plex-web-1',
        status: 'running',
        image: 'plexinc/pms-docker',
        service: 'web',
        ports: [],
        mounts: [
          { type: 'bind', source: '/home/user/media', destination: '/media', rw: true },
          { type: 'bind', source: '/home/user/config', destination: '/config', rw: false },
        ],
      },
    ];
    renderPanel({ ...defaultProps, containers: containersWithMounts });

    expect(screen.getByText('/home/user/media -> /media')).not.toBeNull();
    expect(screen.getByText('/home/user/config -> /config [ro]')).not.toBeNull();
  });

  it('renders nothing extra when a container has no ports and no mounts', () => {
    renderPanel();
    expect(screen.queryByLabelText(/mounts/i)).toBeNull();
  });
});

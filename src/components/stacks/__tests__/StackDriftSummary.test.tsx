import { describe, expect, it, mock } from 'bun:test';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { StackDriftReport } from '@/types/stacks';

const mockResolveDrift = mock(() => Promise.resolve({}));

mock.module('@/data/stacks/functions', () => ({
  resolveDrift: mockResolveDrift,
}));

const { default: StackDriftSummary } = await import('@/components/stacks/StackDriftSummary');

const report: StackDriftReport = {
  items: [
    { kind: 'ghost', host: 'alpha', stack: 'plex', repoComposeHash: 'repo-hash', latestDeployStatus: 'succeeded' },
    { kind: 'untracked', host: 'alpha', stack: 'grafana', agentComposeHash: 'agent-hash' },
  ],
  summary: { total: 2, ghost: 1, untracked: 1, content: 0 },
  scanErrors: [],
  hostAnomalies: [],
};

const emptyReport: StackDriftReport = {
  items: [],
  summary: { total: 0, ghost: 0, untracked: 0, content: 0 },
  scanErrors: [],
  hostAnomalies: [],
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function renderSummary(props: Partial<Parameters<typeof StackDriftSummary>[0]> = {}) {
  return render(
    <StackDriftSummary report={report} isLoading={false} onRefresh={() => {}} {...props} />,
    { wrapper: createWrapper() },
  );
}

describe('StackDriftSummary', () => {
  it('renders summary counts by drift kind', () => {
    renderSummary();
    expect(screen.getByText(/1 ghost, 1 untracked, 0 content/i)).toBeDefined();
  });

  it('lists each drifted stack with its host and kind label', () => {
    renderSummary();
    expect(screen.getByText('alpha/plex')).toBeDefined();
    expect(screen.getByText('Ghost')).toBeDefined();
    expect(screen.getByText('alpha/grafana')).toBeDefined();
    expect(screen.getByText('Untracked')).toBeDefined();
  });

  it('renders the allowed resolutions for each drifted stack', () => {
    renderSummary();
    const labels = screen.getAllByRole('button').map((btn) => btn.textContent);
    expect(labels).toEqual([
      'Refresh',
      'Redeploy from repo',
      'Drop from repo',
      'Adopt into repo',
      'Tear down on host',
    ]);
  });

  it('opens a confirmation naming the host, stack and loss instead of resolving immediately', async () => {
    renderSummary();
    fireEvent.click(screen.getByRole('button', { name: 'Tear down on host' }));
    await screen.findByRole('dialog');
    expect(screen.getByText(/Tear down on host: alpha\/grafana\?/i)).toBeDefined();
    expect(screen.getByText(/compose file that exists only on alpha/i)).toBeDefined();
    expect(mockResolveDrift).not.toHaveBeenCalled();
  });

  it('calls onRefresh when the refresh button is clicked', () => {
    const onRefresh = mock(() => {});
    renderSummary({ onRefresh });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when there is no drift, no scan errors and no host anomalies', () => {
    const { container } = renderSummary({ report: emptyReport });
    expect(container.textContent).toBe('');
  });

  it('renders a warning with the host name and message when host anomalies exist', () => {
    renderSummary({
      report: { ...emptyReport, hostAnomalies: [{ host: 'alpha', message: 'agent returned an empty inventory' }] },
    });
    expect(screen.getByText('Agent inventory looks wrong')).toBeDefined();
    expect(screen.getByText('alpha')).toBeDefined();
    expect(screen.getByText('agent returned an empty inventory')).toBeDefined();
  });

  it('does not render the anomaly section when the host anomaly list is empty', () => {
    renderSummary();
    expect(screen.queryByText('Agent inventory looks wrong')).toBeNull();
  });

  it('still renders when only host anomalies exist', () => {
    renderSummary({
      report: { ...emptyReport, hostAnomalies: [{ host: 'beta', message: 'agent unreachable from collector' }] },
    });
    expect(screen.getByText('Agent inventory looks wrong')).toBeDefined();
    expect(screen.getByText('beta')).toBeDefined();
  });

  it('renders the loading alert when the first scan is in flight', () => {
    renderSummary({ report: null, isLoading: true });
    expect(screen.getByText(/Checking agent stack state/i)).toBeDefined();
  });

  it('renders scan errors with host and message', () => {
    renderSummary({ report: { ...emptyReport, scanErrors: [{ host: 'alpha', message: 'agent unreachable' }] } });
    expect(screen.getByText(/alpha: agent unreachable/i)).toBeDefined();
  });

  it('qualifies a scan error with the stack name when the failure is stack-scoped', () => {
    render(
      <StackDriftSummary
        report={{
          ...emptyReport,
          scanErrors: [
            { host: 'alpha', stack: 'plex', message: 'EACCES: permission denied' },
            { host: 'alpha', stack: 'grafana', message: 'EIO' },
          ],
        }}
        isLoading={false}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText(/alpha\/plex: EACCES: permission denied/i)).toBeDefined();
    expect(screen.getByText(/alpha\/grafana: EIO/i)).toBeDefined();
  });
});

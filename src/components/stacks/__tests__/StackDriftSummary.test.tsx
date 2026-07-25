import { describe, expect, it, mock } from 'bun:test';
import { fireEvent, render, screen } from '@testing-library/react';
import StackDriftSummary from '@/components/stacks/StackDriftSummary';
import type { StackDriftReport } from '@/types/stacks';

const report: StackDriftReport = {
  items: [
    { kind: 'ghost', host: 'alpha', stack: 'plex', repoComposeHash: 'repo-hash', latestDeployStatus: 'succeeded' },
    { kind: 'untracked', host: 'alpha', stack: 'grafana', agentComposeHash: 'agent-hash' },
  ],
  summary: { total: 2, ghost: 1, untracked: 1, content: 0 },
  scanErrors: [],
};

const emptyReport: StackDriftReport = {
  items: [],
  summary: { total: 0, ghost: 0, untracked: 0, content: 0 },
  scanErrors: [],
};

describe('StackDriftSummary', () => {
  it('renders summary counts by drift kind', () => {
    render(<StackDriftSummary report={report} isLoading={false} onRefresh={() => {}} />);
    expect(screen.getByText(/1 ghost, 1 untracked, 0 content/i)).toBeDefined();
  });

  it('lists each drifted stack with its host and kind label', () => {
    render(<StackDriftSummary report={report} isLoading={false} onRefresh={() => {}} />);
    expect(screen.getByText('alpha/plex')).toBeDefined();
    expect(screen.getByText('Ghost')).toBeDefined();
    expect(screen.getByText('alpha/grafana')).toBeDefined();
    expect(screen.getByText('Untracked')).toBeDefined();
  });

  it('renders no resolution controls', () => {
    render(<StackDriftSummary report={report} isLoading={false} onRefresh={() => {}} />);
    expect(screen.getAllByRole('button').map((btn) => btn.textContent)).toEqual(['Refresh']);
  });

  it('calls onRefresh when the refresh button is clicked', () => {
    const onRefresh = mock(() => {});
    render(<StackDriftSummary report={report} isLoading={false} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when there is no drift and no scan errors', () => {
    const { container } = render(
      <StackDriftSummary report={emptyReport} isLoading={false} onRefresh={() => {}} />,
    );
    expect(container.textContent).toBe('');
  });

  it('renders the loading alert when the first scan is in flight', () => {
    render(<StackDriftSummary report={null} isLoading onRefresh={() => {}} />);
    expect(screen.getByText(/Checking agent stack state/i)).toBeDefined();
  });

  it('renders scan errors with host and message', () => {
    render(
      <StackDriftSummary
        report={{ ...emptyReport, scanErrors: [{ host: 'alpha', message: 'agent unreachable' }] }}
        isLoading={false}
        onRefresh={() => {}}
      />,
    );
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

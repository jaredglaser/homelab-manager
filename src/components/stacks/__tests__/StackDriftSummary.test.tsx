import { describe, expect, it, mock } from 'bun:test';
import { fireEvent, render, screen } from '@testing-library/react';
import StackDriftSummary from '../StackDriftSummary';
import type { StackDriftReport } from '@/types/stacks';

const report: StackDriftReport = {
  items: [
    {
      host: 'alpha',
      stack: 'plex',
      kind: 'ghost',
      repoComposeHash: 'repo-hash',
      latestDeployStatus: 'succeeded',
    },
    {
      host: 'alpha',
      stack: 'grafana',
      kind: 'untracked',
      agentComposeHash: 'agent-hash',
      latestDeployStatus: null,
    },
  ],
  summary: {
    total: 2,
    ghost: 1,
    untracked: 1,
    content: 0,
  },
  scanErrors: [],
};

describe('StackDriftSummary', () => {
  it('renders summary counts by drift kind', () => {
    render(
      <StackDriftSummary
        report={report}
        isLoading={false}
        isResolving={false}
        onRefresh={() => {}}
        onResolve={() => {}}
      />,
    );

    expect(screen.getByText(/1 ghost, 1 untracked, 0 content/i)).toBeDefined();
  });

  it('hides invalid actions for untracked items', () => {
    render(
      <StackDriftSummary
        report={report}
        isLoading={false}
        isResolving={false}
        onRefresh={() => {}}
        onResolve={() => {}}
      />,
    );

    const trustRepoButtons = screen.queryAllByRole('button', { name: 'Trust Repo' });
    expect(trustRepoButtons).toHaveLength(1);
  });

  it('calls onResolve with the selected item and resolution', () => {
    const onResolve = mock(() => {});
    render(
      <StackDriftSummary
        report={report}
        isLoading={false}
        isResolving={false}
        onRefresh={() => {}}
        onResolve={onResolve}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Trust Agent' })[0]);
    expect(onResolve).toHaveBeenCalledWith(report.items[0], 'trust_agent');
  });

  it('renders nothing when there is no drift and no scan errors', () => {
    const { container } = render(
      <StackDriftSummary
        report={{ items: [], summary: { total: 0, ghost: 0, untracked: 0, content: 0 }, scanErrors: [] }}
        isLoading={false}
        isResolving={false}
        onRefresh={() => {}}
        onResolve={() => {}}
      />,
    );
    expect(container.textContent).toBe('');
  });

  it('renders the loading alert when the first scan is in flight', () => {
    render(
      <StackDriftSummary
        report={null}
        isLoading
        isResolving={false}
        onRefresh={() => {}}
        onResolve={() => {}}
      />,
    );
    expect(screen.getByText(/Checking agent stack state/i)).toBeDefined();
  });

  it('renders scan errors with host and message', () => {
    render(
      <StackDriftSummary
        report={{
          items: [],
          summary: { total: 0, ghost: 0, untracked: 0, content: 0 },
          scanErrors: [{ host: 'alpha', message: 'agent unreachable' }],
        }}
        isLoading={false}
        isResolving={false}
        onRefresh={() => {}}
        onResolve={() => {}}
      />,
    );
    expect(screen.getByText(/alpha: agent unreachable/i)).toBeDefined();
  });

  it('disables resolve buttons while a scan is in flight', () => {
    render(
      <StackDriftSummary
        report={report}
        isLoading
        isResolving={false}
        onRefresh={() => {}}
        onResolve={() => {}}
      />,
    );
    for (const btn of screen.getAllByRole('button', { name: 'Trust Agent' })) {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('disables resolve buttons while a resolution is in flight', () => {
    render(
      <StackDriftSummary
        report={report}
        isLoading={false}
        isResolving
        onRefresh={() => {}}
        onResolve={() => {}}
      />,
    );
    for (const btn of screen.getAllByRole('button', { name: 'Trust Agent' })) {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    }
  });
});

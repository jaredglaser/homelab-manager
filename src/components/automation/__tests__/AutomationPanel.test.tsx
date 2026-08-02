import { describe, it, expect, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { AutomationPanel, type AutomationPanelProps } from '@/components/automation/AutomationPanel';

function renderPanel(overrides: Partial<AutomationPanelProps> = {}) {
  const props: AutomationPanelProps = {
    hosts: ['host-a', 'host-b'],
    selectedHosts: [],
    onToggleHost: mock(() => {}),
    checkMode: false,
    onCheckModeChange: mock(() => {}),
    onRun: mock(() => {}),
    isRunning: false,
    status: null,
    lines: [],
    summaries: [],
    error: null,
    ...overrides,
  };
  render(<AutomationPanel {...props} />);
  return props;
}

describe('AutomationPanel', () => {
  it('says so when no hosts are registered', () => {
    renderPanel({ hosts: [] });
    expect(screen.getByText('No managed hosts registered.')).toBeTruthy();
  });

  it('disables the run button until a host is selected', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: 'Run host baseline' }).hasAttribute('disabled')).toBe(true);
  });

  it('runs when a host is selected', () => {
    const props = renderPanel({ selectedHosts: ['host-a'] });
    fireEvent.click(screen.getByRole('button', { name: 'Run host baseline' }));
    expect(props.onRun).toHaveBeenCalledTimes(1);
  });

  it('reports a run in flight and blocks a second click', () => {
    renderPanel({ selectedHosts: ['host-a'], isRunning: true });
    const button = screen.getByRole('button', { name: 'Running...' });
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('toggles a host and check mode', () => {
    const props = renderPanel();
    fireEvent.click(screen.getByRole('checkbox', { name: 'host-b' }));
    expect(props.onToggleHost).toHaveBeenCalledWith('host-b');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Preview only (--check --diff)' }));
    expect(props.onCheckModeChange).toHaveBeenCalledWith(true);
  });

  it('shows an error when one is given', () => {
    renderPanel({ error: 'hosts already running: host-a' });
    expect(screen.getByText('hosts already running: host-a')).toBeTruthy();
  });

  it('hides the output and summary sections until there is something to show', () => {
    renderPanel();
    expect(screen.queryByText('Run output')).toBeNull();
    expect(screen.queryByText('Per-host result')).toBeNull();
  });

  it('renders task lines with and without a detail', () => {
    renderPanel({
      status: 'running',
      lines: [
        { key: 'a', label: 'PLAY Host baseline', detail: null },
        { key: 'b', label: 'TASK Install', detail: 'package' },
      ],
    });

    expect(screen.getByText('Run output')).toBeTruthy();
    expect(screen.getByText('PLAY Host baseline')).toBeTruthy();
    expect(screen.getByText('TASK Install [package]')).toBeTruthy();
  });

  it('renders a per-host row for every outcome, including unreachable', () => {
    renderPanel({
      status: 'succeeded',
      summaries: [
        { host: 'host-a', ok: 4, changed: 2, failures: 0, unreachable: 0, skipped: 1, outcome: 'changed' },
        { host: 'host-b', ok: 0, changed: 0, failures: 0, unreachable: 1, skipped: 0, outcome: 'unreachable' },
        { host: 'host-c', ok: 1, changed: 0, failures: 1, unreachable: 0, skipped: 0, outcome: 'failed' },
        { host: 'host-d', ok: 3, changed: 0, failures: 0, unreachable: 0, skipped: 0, outcome: 'ok' },
      ],
    });

    expect(screen.getByText('Per-host result')).toBeTruthy();
    expect(screen.getByText('unreachable')).toBeTruthy();
    expect(screen.getByText('failed')).toBeTruthy();
    expect(screen.getByText('changed')).toBeTruthy();
    expect(screen.getAllByText(/^ok \d$/)).toHaveLength(4);
  });

  it('marks a failed run status distinctly', () => {
    renderPanel({ status: 'failed', lines: [{ key: 'a', label: 'PLAY x', detail: null }] });
    expect(screen.getByText('failed')).toBeTruthy();
  });
});

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Finding } from '@/lib/findings/types';
import type { DockerInventorySnapshotContainer } from '@/types/docker-inventory';

type TestOperatorVerdict = 'actionable' | 'noise' | 'duplicate' | 'wrong';

interface ReportMissTestInput {
  entityIds: readonly string[];
  whatHappened: string;
  severity: string;
  windowFrom: Date;
  windowTo: Date;
}

interface TestVerdictSummary {
  findingId: number;
  verdict: TestOperatorVerdict;
  source: 'operator' | 'agent';
  note: string;
  duplicateOfFindingId: number | null;
  labeledBy: string | null;
  labeledAt: Date;
  relabelCount: number;
}

type TestImplicitSignal = 'rollback_after' | 'nonzero_exit_after' | 'restart_after' | 'redeploy_after' | 'quiet_24h' | 'no_outcome_observed';
type TestConfounder =
  | 'periodic_restart'
  | 'host_wide_event'
  | 'frequent_deploys'
  | 'sigkill_ambiguous'
  | 'short_lived_container'
  | 'multiple_candidate_findings'
  | 'operator_may_have_acted'
  | 'slow_burn_candidate';

interface TestWeakSignalSummary {
  findingId: number;
  actionableWeight: number;
  noiseWeight: number;
  signalCount: number;
  signals: TestImplicitSignal[];
  confounders: TestConfounder[];
  lastInferredAt: Date;
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 1,
    subjectKind: 'container',
    subjectId: 'server-1/abc123',
    entityIds: ['server-1/abc123'],
    fingerprint: 'postgres-connection-refused',
    severity: 'critical',
    status: 'open',
    title: 'Postgres refusing connections',
    detail: 'The container logged repeated connection refused errors.',
    evidence: [],
    incidentIds: [],
    runId: 'run-1',
    source: 'agent',
    occurrences: 1,
    windowFrom: null,
    windowTo: null,
    firstSeenAt: new Date('2026-08-16T11:00:00Z'),
    lastSeenAt: new Date('2026-08-16T12:05:00Z'),
    resolvedAt: null,
    resolution: null,
    ...overrides,
  } as Finding;
}

function makeVerdict(overrides: Partial<TestVerdictSummary> = {}): TestVerdictSummary {
  return {
    findingId: 1,
    verdict: 'actionable',
    source: 'operator',
    note: '',
    duplicateOfFindingId: null,
    labeledBy: 'jared@glaserfamily.net',
    labeledAt: new Date('2026-08-16T13:00:00Z'),
    relabelCount: 0,
    ...overrides,
  };
}

function makeWeakSignals(overrides: Partial<TestWeakSignalSummary> = {}): TestWeakSignalSummary {
  return {
    findingId: 1,
    actionableWeight: 0.3,
    noiseWeight: 0,
    signalCount: 1,
    signals: ['restart_after'],
    confounders: [],
    lastInferredAt: new Date('2026-08-16T12:30:00Z'),
    ...overrides,
  };
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

let mockFindingsResult: { findings: Finding[]; isConnected: boolean; error: string | null } = {
  findings: [],
  isConnected: true,
  error: null,
};

mock.module('@/hooks/useFindings', () => ({
  useFindings: () => mockFindingsResult,
}));

let mockInventory = new Map<string, DockerInventorySnapshotContainer>();

mock.module('@/hooks/useDockerInventory', () => ({
  useDockerInventory: () => ({ inventory: mockInventory, isConnected: true, error: null }),
}));

let mockCanWrite = true;

mock.module('@/hooks/useAuth', () => ({
  useCanWrite: () => mockCanWrite,
}));

const mockShowToast = mock(() => {});

mock.module('@/hooks/toastAtom', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}));

const mockGetFeedbackMetrics = mock(() => Promise.resolve(null as unknown));
const mockReportMiss = mock(() => Promise.resolve(null as unknown));
const mockSetMissStatus = mock(() => Promise.resolve(null as unknown));

mock.module('@/data/feedback/functions', () => ({
  getFeedbackMetrics: mockGetFeedbackMetrics,
  reportMiss: mockReportMiss,
  setMissStatus: mockSetMissStatus,
}));

const { FindingCard } = await import('@/components/findings/FindingCard');
const { default: ReportIncidentDialog } = await import('@/components/findings/ReportIncidentDialog');
const { FeedbackMetrics } = await import('@/components/findings/FeedbackMetrics');
const { LogAnalysisPage } = await import('@/routes/log-analysis');

const fullMetrics = {
  findings: { total: 12, previousTotal: 9 },
  coverage: { labeled: 10, total: 12, coverage: 0.83 },
  precision: {
    value: 0.8,
    n: 25,
    wilson95: { low: 0.6, high: 0.92 },
    withheldReason: null,
    decisive: { actionable: 20, noise: 4, wrong: 1 },
  },
  reportedMisses: { total: 3, byAttributionVerdict: { finding_exists: 1, batched_only: 2 } },
  tierZeroLatency: { medianMs: 4200, p90Ms: 9100, n: 14, latenciesMs: [], neverDispatched: 2 },
  spend: { totalRuns: 340, byBucket: { t0: 40, t1: 120, t2: 150, page: 30 }, estimatedCostUsd: null },
  rulesTransitions: { total: 0 },
};

const sparseMetrics = {
  findings: { total: 2, previousTotal: 1 },
  coverage: { labeled: 1, total: 2, coverage: 0.5 },
  precision: {
    value: null,
    n: 3,
    wilson95: null,
    withheldReason: 'insufficient_labels',
    decisive: { actionable: 2, noise: 1, wrong: 0 },
  },
  reportedMisses: { total: 0, byAttributionVerdict: {} },
  tierZeroLatency: { medianMs: null, p90Ms: null, n: 2, latenciesMs: [1200, 3400], neverDispatched: 0 },
  spend: { totalRuns: 5, byBucket: { t0: 5 }, estimatedCostUsd: null },
  rulesTransitions: { total: 0 },
};

const emptyMetrics = {
  findings: { total: 0, previousTotal: 0 },
  coverage: { labeled: 0, total: 0, coverage: 0 },
  precision: {
    value: null,
    n: 0,
    wilson95: null,
    withheldReason: 'insufficient_labels',
    decisive: { actionable: 0, noise: 0, wrong: 0 },
  },
  reportedMisses: { total: 0, byAttributionVerdict: {} },
  tierZeroLatency: { medianMs: null, p90Ms: null, n: 0, latenciesMs: [], neverDispatched: 0 },
  spend: { totalRuns: 0, byBucket: {}, estimatedCostUsd: null },
  rulesTransitions: { total: 0 },
};

beforeEach(() => {
  mockFindingsResult = { findings: [], isConnected: true, error: null };
  mockInventory = new Map();
  mockCanWrite = true;
  mockShowToast.mockClear();
  mockGetFeedbackMetrics.mockClear();
  mockReportMiss.mockClear();
  mockSetMissStatus.mockClear();
  mockGetFeedbackMetrics.mockImplementation(() => Promise.resolve(fullMetrics as unknown));
});

describe('FindingCard verdict controls', () => {
  it('renders no verdict controls for a viewer with no existing verdict', () => {
    render(<FindingCard finding={makeFinding()} defaultExpanded canLabel={false} />);
    expect(screen.queryByRole('button', { name: 'Actionable' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Noise' })).toBeNull();
  });

  it.each(['Actionable', 'Noise', 'Duplicate', 'Wrong'] as const)(
    'submits the %s verdict in one click',
    (label) => {
      const onLabel = mock(() => {});
      render(<FindingCard finding={makeFinding()} defaultExpanded canLabel onLabel={onLabel} />);
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(onLabel).toHaveBeenCalledTimes(1);
      expect(onLabel).toHaveBeenCalledWith({ verdict: label.toLowerCase(), note: undefined });
    },
  );

  it('includes a trimmed note only when the note field was opened and filled in', () => {
    const onLabel = mock(() => {});
    render(<FindingCard finding={makeFinding()} defaultExpanded canLabel onLabel={onLabel} />);
    fireEvent.click(screen.getByText('Add note'));
    fireEvent.change(screen.getByPlaceholderText('Optional note'), { target: { value: '  restarted on its own  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Actionable' }));
    expect(onLabel).toHaveBeenCalledWith({ verdict: 'actionable', note: 'restarted on its own' });
  });

  it('disables the verdict buttons while a label is in flight', () => {
    render(<FindingCard finding={makeFinding()} defaultExpanded canLabel isLabeling onLabel={() => {}} />);
    expect((screen.getByRole('button', { name: 'Actionable' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the current verdict as a badge instead of buttons, with a Change affordance', () => {
    const onLabel = mock(() => {});
    render(
      <FindingCard
        finding={makeFinding()}
        defaultExpanded
        canLabel
        onLabel={onLabel}
        verdict={makeVerdict({ verdict: 'noise', labeledBy: 'ops@example.com' })}
      />,
    );
    expect(screen.getByText('Noise')).toBeDefined();
    expect(screen.getByText(/changed by ops@example.com/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Actionable' })).toBeNull();
  });

  it('re-reveals the four buttons and relabels on Change', () => {
    const onLabel = mock(() => {});
    render(
      <FindingCard
        finding={makeFinding()}
        defaultExpanded
        canLabel
        onLabel={onLabel}
        verdict={makeVerdict({ verdict: 'noise' })}
      />,
    );
    fireEvent.click(screen.getByText('Change'));
    const actionableButton = screen.getByRole('button', { name: 'Actionable' });
    expect(actionableButton).toBeDefined();
    fireEvent.click(actionableButton);
    expect(onLabel).toHaveBeenCalledWith({ verdict: 'actionable', note: undefined });
  });

  it('shows a relabel history line once relabelCount is above zero', () => {
    render(
      <FindingCard
        finding={makeFinding()}
        defaultExpanded
        canLabel
        verdict={makeVerdict({ relabelCount: 2 })}
      />,
    );
    expect(screen.getByText(/Relabelled 2 times, most recently actionable on/)).toBeDefined();
  });

  it('distinguishes an agent self-correction from an operator verdict', () => {
    render(
      <FindingCard
        finding={makeFinding()}
        defaultExpanded
        canLabel
        verdict={makeVerdict({ source: 'agent', verdict: 'wrong', labeledBy: null })}
      />,
    );
    const badge = screen.getByText('Agent retracted this');
    expect(badge.className).toContain('border');
    expect(screen.queryByText('Change')).toBeNull();
  });

  it('renders weak signals as plain muted text, never inside a Badge', () => {
    render(
      <FindingCard
        finding={makeFinding()}
        defaultExpanded
        weakSignals={makeWeakSignals({ signals: ['restart_after', 'redeploy_after'], confounders: ['frequent_deploys'] })}
      />,
    );
    const line = screen.getByText(/Weak signals:/);
    expect(line.tagName).toBe('P');
    expect(line.textContent).toContain('restarted');
    expect(line.textContent).toContain('redeployed');
    expect(line.textContent).toContain('confounded: frequent_deploys');
    expect(screen.queryByText(/Weak signals:/, { selector: '[data-slot="badge"]' })).toBeNull();
  });

  it('omits the verdict block entirely when there is nothing to show and no write access', () => {
    const { container } = render(<FindingCard finding={makeFinding()} defaultExpanded />);
    expect(container.querySelector('.border-t.border-border')).toBeNull();
  });

  it('leaves finding rendering unchanged for a plain finding prop, matching prior behaviour', () => {
    render(<FindingCard finding={makeFinding()} />);
    expect(screen.getByText('Postgres refusing connections')).toBeDefined();
  });
});

describe('ReportIncidentDialog', () => {
  const entities = [
    { entityId: 'server-1/abc', label: 'postgres', host: 'server-1' },
    { entityId: 'server-1/def', label: 'redis', host: 'server-1' },
  ];

  it('renders nothing when closed', () => {
    render(
      <ReportIncidentDialog
        open={false}
        onClose={() => {}}
        onSubmit={() => {}}
        result={null}
        onSetStatus={() => {}}
        isLoading={false}
        entities={entities}
      />,
    );
    expect(screen.queryByText('Report an incident')).toBeNull();
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = mock(() => {});
    render(
      <ReportIncidentDialog
        open
        onClose={onClose}
        onSubmit={() => {}}
        result={null}
        onSetStatus={() => {}}
        isLoading={false}
        entities={entities}
      />,
    );
    fireEvent.keyDown(screen.getByText('Report an incident'), { key: 'Escape', code: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps submit disabled until an entity and a description are provided, then submits the window and payload', () => {
    const onSubmit = mock((_input: ReportMissTestInput) => {});
    render(
      <ReportIncidentDialog
        open
        onClose={() => {}}
        onSubmit={onSubmit}
        result={null}
        onSetStatus={() => {}}
        isLoading={false}
        entities={entities}
      />,
    );

    const submitButton = screen.getByRole('button', { name: 'Submit report' });
    expect((submitButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText('This broke at 21:40 and nothing was said.'), {
      target: { value: 'Plex stopped responding.' },
    });
    expect((submitButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('checkbox', { name: 'postgres' }));
    expect((submitButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(submitButton);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const call = onSubmit.mock.calls[0][0];
    expect(call.entityIds).toEqual(['server-1/abc']);
    expect(call.whatHappened).toBe('Plex stopped responding.');
    expect(call.severity).toBe('warning');
    expect(call.windowFrom.getTime()).toBeLessThan(call.windowTo.getTime());
  });

  it('applies the last-hour preset to the window inputs', () => {
    render(
      <ReportIncidentDialog
        open
        onClose={() => {}}
        onSubmit={() => {}}
        result={null}
        onSetStatus={() => {}}
        isLoading={false}
        entities={entities}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Last hour' }));
    const from = screen.getByLabelText('Window from') as HTMLInputElement;
    const to = screen.getByLabelText('Window to') as HTMLInputElement;
    const fromMs = new Date(from.value).getTime();
    const toMs = new Date(to.value).getTime();
    expect(Math.round((toMs - fromMs) / 60000)).toBe(60);
  });

  it('shows a validation message and disables submit for an out-of-order window', () => {
    render(
      <ReportIncidentDialog
        open
        onClose={() => {}}
        onSubmit={() => {}}
        result={null}
        onSetStatus={() => {}}
        isLoading={false}
        entities={entities}
      />,
    );
    fireEvent.change(screen.getByLabelText('Window from'), { target: { value: '2026-08-16T12:00' } });
    fireEvent.change(screen.getByLabelText('Window to'), { target: { value: '2026-08-16T10:00' } });
    expect(screen.getByText('The window must be ordered and no more than 7 days.')).toBeDefined();
    expect((screen.getByRole('button', { name: 'Submit report' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('applies the last-4-hours and last-night presets to the window inputs', () => {
    render(
      <ReportIncidentDialog
        open
        onClose={() => {}}
        onSubmit={() => {}}
        result={null}
        onSetStatus={() => {}}
        isLoading={false}
        entities={entities}
      />,
    );
    const from = screen.getByLabelText('Window from') as HTMLInputElement;
    const to = screen.getByLabelText('Window to') as HTMLInputElement;

    fireEvent.click(screen.getByRole('button', { name: 'Last 4 hours' }));
    expect(Math.round((new Date(to.value).getTime() - new Date(from.value).getTime()) / 60000)).toBe(240);

    fireEvent.click(screen.getByRole('button', { name: 'Last night (22:00-06:00)' }));
    const fromDate = new Date(from.value);
    const toDate = new Date(to.value);
    expect(fromDate.getHours()).toBe(22);
    expect(toDate.getHours()).toBe(6);
    expect(toDate.getTime() - fromDate.getTime()).toBe(8 * 60 * 60 * 1000);
  });

  it('submits the selected severity', () => {
    const onSubmit = mock((_input: ReportMissTestInput) => {});
    render(
      <ReportIncidentDialog
        open
        onClose={() => {}}
        onSubmit={onSubmit}
        result={null}
        onSetStatus={() => {}}
        isLoading={false}
        entities={entities}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Critical' }));
    fireEvent.change(screen.getByPlaceholderText('This broke at 21:40 and nothing was said.'), {
      target: { value: 'Plex stopped responding.' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'postgres' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit report' }));
    expect(onSubmit.mock.calls[0][0].severity).toBe('critical');
  });

  it('shows the attribution result view instead of closing on submit', () => {
    const onSetStatus = mock(() => {});
    render(
      <ReportIncidentDialog
        open
        onClose={() => {}}
        onSubmit={() => {}}
        result={{
          miss: { id: 7 } as never,
          attributionFailed: false,
          attribution: {
            verdict: 'batched_only',
            findings: [],
            incidents: [],
            shapes: [{ shapeId: 'jellyfin-chatter' }],
            entityHadTraffic: true,
            computedAt: new Date(),
            windowFrom: new Date(),
            windowTo: new Date(),
          } as never,
        }}
        onSetStatus={onSetStatus}
        isLoading={false}
        entities={entities}
      />,
    );
    expect(screen.getByText('Routed to the digest.')).toBeDefined();
    expect(screen.getByText(/1 shape/)).toBeDefined();

    const auditToggle = screen.getByText('View full audit');
    fireEvent.click(auditToggle);
    expect(screen.getByText(/jellyfin-chatter/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Accept as a miss' }));
    expect(onSetStatus).toHaveBeenCalledWith('accepted');
    fireEvent.click(screen.getByRole('button', { name: 'This is explained' }));
    expect(onSetStatus).toHaveBeenCalledWith('explained');
  });

  it('falls back to a saved-without-attribution message when attribution failed', () => {
    render(
      <ReportIncidentDialog
        open
        onClose={() => {}}
        onSubmit={() => {}}
        result={{ miss: { id: 8 } as never, attributionFailed: true, attribution: null }}
        onSetStatus={() => {}}
        isLoading={false}
        entities={entities}
      />,
    );
    expect(screen.getByText('The miss was saved. Attribution could not be completed automatically.')).toBeDefined();
  });

  it('calls onClose from Cancel', () => {
    const onClose = mock(() => {});
    render(
      <ReportIncidentDialog
        open
        onClose={onClose}
        onSubmit={() => {}}
        result={null}
        onSetStatus={() => {}}
        isLoading={false}
        entities={entities}
      />,
    );
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('groups entities by host and shows a message when the inventory is empty', () => {
    render(
      <ReportIncidentDialog
        open
        onClose={() => {}}
        onSubmit={() => {}}
        result={null}
        onSetStatus={() => {}}
        isLoading={false}
        entities={[]}
      />,
    );
    expect(screen.getByText('No containers in the inventory yet.')).toBeDefined();
  });
});

describe('FeedbackMetrics', () => {
  it('shows a loading state before data arrives', () => {
    render(<FeedbackMetrics />, { wrapper: createWrapper() });
    expect(screen.getByText('Loading feedback metrics…')).toBeDefined();
  });

  it('shows an error state when the fetch fails', async () => {
    mockGetFeedbackMetrics.mockImplementation(() => Promise.reject(new Error('boom')));
    render(<FeedbackMetrics />, { wrapper: createWrapper() });
    expect(await screen.findByText('Feedback metrics unavailable')).toBeDefined();
  });

  it('renders populated metrics with real numbers', async () => {
    render(<FeedbackMetrics />, { wrapper: createWrapper() });
    expect(await screen.findByText(/10\/12 \(83%\)/)).toBeDefined();
    expect(screen.getByText(/80% \(n=25\)/)).toBeDefined();
    expect(screen.getByText(/1 finding exists, 2 batched only/)).toBeDefined();
    expect(screen.getByText(/median 4\.2s/)).toBeDefined();
    expect(screen.getByText(/2 never dispatched/)).toBeDefined();
    expect(screen.getByText(/340 runs/)).toBeDefined();
    expect(screen.getByText(/\+3 vs last week/)).toBeDefined();
  });

  it('withholds precision and latency when the sample is too small to be meaningful', async () => {
    mockGetFeedbackMetrics.mockImplementation(() => Promise.resolve(sparseMetrics as unknown));
    render(<FeedbackMetrics />, { wrapper: createWrapper() });
    expect(await screen.findByText(/n too small/)).toBeDefined();
    expect(screen.getByText(/not enough labels yet \(3 of 20\)/)).toBeDefined();
    expect(screen.getByText(/1\.2s, 3\.4s/)).toBeDefined();
  });

  it('renders the empty state without dividing by zero', async () => {
    mockGetFeedbackMetrics.mockImplementation(() => Promise.resolve(emptyMetrics as unknown));
    render(<FeedbackMetrics />, { wrapper: createWrapper() });
    expect(await screen.findByText(/0\/0 \(0%\)/)).toBeDefined();
    expect(screen.getByText(/no data/)).toBeDefined();
    expect(screen.getByText(/no change/)).toBeDefined();
  });

  it('expands to reveal metric definitions', async () => {
    render(<FeedbackMetrics />, { wrapper: createWrapper() });
    await screen.findByText(/10\/12 \(83%\)/);
    expect(screen.queryByText(/Findings this week counts finding rows/)).toBeNull();
    fireEvent.click(screen.getByText('Findings this week'));
    expect(await screen.findByText(/Findings this week counts finding rows/)).toBeDefined();
  });
});

describe('LogAnalysisPage', () => {
  it('shows the report button for a writer and hides it for a viewer', () => {
    const { rerender } = render(<LogAnalysisPage />, { wrapper: createWrapper() });
    expect(screen.getByRole('button', { name: 'Report an incident' })).toBeDefined();

    mockCanWrite = false;
    rerender(<LogAnalysisPage />);
    expect(screen.queryByRole('button', { name: 'Report an incident' })).toBeNull();
  });

  it('opens the dialog, submits a miss, and surfaces the attribution result', async () => {
    mockInventory = new Map([
      [
        'server-1/abc',
        {
          host: 'server-1',
          containerId: 'abc',
          name: 'postgres',
          image: 'postgres:16',
          state: 'running',
          composeProject: null,
          serviceKey: 'postgres',
          startedAt: null,
          finishedAt: null,
          exitCode: null,
          updatedAt: new Date(),
          labels: {},
          ports: [],
          mounts: [],
        } as DockerInventorySnapshotContainer,
      ],
    ]);

    const attribution = {
      verdict: 'nothing_recorded' as const,
      findings: [],
      incidents: [],
      shapes: [],
      entityHadTraffic: false,
      computedAt: new Date(),
      windowFrom: new Date(),
      windowTo: new Date(),
    };
    mockReportMiss.mockImplementation(() => Promise.resolve({ miss: { id: 42 }, attribution, attributionFailed: false } as unknown));

    render(<LogAnalysisPage />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByRole('button', { name: 'Report an incident' }));
    fireEvent.change(screen.getByPlaceholderText('This broke at 21:40 and nothing was said.'), {
      target: { value: 'Plex stopped responding.' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'postgres' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit report' }));

    expect(mockReportMiss).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Nothing was recorded in this window.')).toBeDefined();

    mockSetMissStatus.mockImplementation(() => Promise.resolve({ id: 42, status: 'accepted' } as unknown));
    fireEvent.click(screen.getByRole('button', { name: 'Accept as a miss' }));
    await waitFor(() => expect(mockSetMissStatus).toHaveBeenCalledWith({ data: { id: 42, status: 'accepted' } }));
  });

  it('shows a toast and keeps the dialog open when reporting fails', async () => {
    mockInventory = new Map([
      [
        'server-1/abc',
        {
          host: 'server-1',
          containerId: 'abc',
          name: 'postgres',
          image: 'postgres:16',
          state: 'running',
          composeProject: null,
          serviceKey: 'postgres',
          startedAt: null,
          finishedAt: null,
          exitCode: null,
          updatedAt: new Date(),
          labels: {},
          ports: [],
          mounts: [],
        } as DockerInventorySnapshotContainer,
      ],
    ]);
    mockReportMiss.mockImplementation(() => Promise.reject(new Error('network down')));
    render(<LogAnalysisPage />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByRole('button', { name: 'Report an incident' }));
    fireEvent.change(screen.getByPlaceholderText('This broke at 21:40 and nothing was said.'), {
      target: { value: 'Plex stopped responding.' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'postgres' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit report' }));

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('network down', 'error'));
    expect(screen.getByRole('button', { name: 'Submit report' })).toBeDefined();
  });

  it('marks a reported miss as explained and closes the dialog', async () => {
    mockInventory = new Map([
      [
        'server-1/abc',
        {
          host: 'server-1',
          containerId: 'abc',
          name: 'postgres',
          image: 'postgres:16',
          state: 'running',
          composeProject: null,
          serviceKey: 'postgres',
          startedAt: null,
          finishedAt: null,
          exitCode: null,
          updatedAt: new Date(),
          labels: {},
          ports: [],
          mounts: [],
        } as DockerInventorySnapshotContainer,
      ],
    ]);
    const attribution = {
      verdict: 'batched_only' as const,
      findings: [],
      incidents: [],
      shapes: [{ shapeId: 'chatter' }],
      entityHadTraffic: true,
      computedAt: new Date(),
      windowFrom: new Date(),
      windowTo: new Date(),
    };
    mockReportMiss.mockImplementation(() => Promise.resolve({ miss: { id: 9 }, attribution, attributionFailed: false } as unknown));
    mockSetMissStatus.mockImplementation(() => Promise.resolve({ id: 9, status: 'explained' } as unknown));

    render(<LogAnalysisPage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByRole('button', { name: 'Report an incident' }));
    fireEvent.change(screen.getByPlaceholderText('This broke at 21:40 and nothing was said.'), {
      target: { value: 'Plex stopped responding.' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'postgres' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit report' }));

    fireEvent.click(await screen.findByRole('button', { name: 'This is explained' }));
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Recorded as explained', 'success'));
    await waitFor(() => expect(screen.queryByText('Routed to the digest.')).toBeNull());
  });

  it('shows an error toast when marking the reported miss fails', async () => {
    mockInventory = new Map([
      [
        'server-1/abc',
        {
          host: 'server-1',
          containerId: 'abc',
          name: 'postgres',
          image: 'postgres:16',
          state: 'running',
          composeProject: null,
          serviceKey: 'postgres',
          startedAt: null,
          finishedAt: null,
          exitCode: null,
          updatedAt: new Date(),
          labels: {},
          ports: [],
          mounts: [],
        } as DockerInventorySnapshotContainer,
      ],
    ]);
    mockReportMiss.mockImplementation(() => Promise.resolve({ miss: { id: 10 }, attribution: null, attributionFailed: true } as unknown));
    mockSetMissStatus.mockImplementation(() => Promise.reject(new Error('write failed')));

    render(<LogAnalysisPage />, { wrapper: createWrapper() });
    fireEvent.click(screen.getByRole('button', { name: 'Report an incident' }));
    fireEvent.change(screen.getByPlaceholderText('This broke at 21:40 and nothing was said.'), {
      target: { value: 'Plex stopped responding.' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'postgres' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit report' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Accept as a miss' }));
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('write failed', 'error'));
  });
});

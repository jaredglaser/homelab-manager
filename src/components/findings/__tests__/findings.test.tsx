import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Finding } from '@/lib/findings/types';

type FindingFixture = Finding;

function makeFinding(overrides: Partial<FindingFixture> = {}): FindingFixture {
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
    evidence: [
      {
        kind: 'log_line',
        at: new Date('2026-08-16T12:00:00Z'),
        source: 'stderr',
        text: 'FATAL: connection refused',
        truncated: false,
      },
    ],
    incidentIds: ['inc-e-1'],
    runId: 'run-1',
    source: 'agent',
    occurrences: 1,
    windowFrom: new Date('2026-08-16T11:00:00Z'),
    windowTo: new Date('2026-08-16T12:00:00Z'),
    firstSeenAt: new Date('2026-08-16T11:00:00Z'),
    lastSeenAt: new Date('2026-08-16T12:05:00Z'),
    resolvedAt: null,
    resolution: null,
    ...overrides,
  } as FindingFixture;
}

let mockResult: { findings: Finding[]; isConnected: boolean; error: string | null } = {
  findings: [],
  isConnected: true,
  error: null,
};

mock.module('@/hooks/useFindings', () => ({
  useFindings: () => mockResult,
}));

const { default: FindingsFeed } = await import('@/components/findings/FindingsFeed');
const { FindingCard } = await import('@/components/findings/FindingCard');

beforeEach(() => {
  mockResult = { findings: [], isConnected: true, error: null };
});

describe('FindingsFeed', () => {
  it('renders a connecting state before any data has arrived', () => {
    mockResult = { findings: [], isConnected: false, error: null };
    render(<FindingsFeed />);
    expect(screen.getByText('Connecting to the findings stream…')).toBeDefined();
  });

  it('renders the empty state once connected with no findings', () => {
    mockResult = { findings: [], isConnected: true, error: null };
    render(<FindingsFeed />);
    expect(screen.getByText('No findings yet.')).toBeDefined();
    expect(
      screen.getByText('A triage run records one only when it concludes something is wrong. Most runs conclude nothing.'),
    ).toBeDefined();
  });

  it('renders a list of findings', () => {
    mockResult = {
      findings: [
        makeFinding({ id: 1, title: 'Postgres refusing connections' }),
        makeFinding({ id: 2, title: 'Disk nearly full', fingerprint: 'disk-nearly-full', severity: 'warning' }),
      ],
      isConnected: true,
      error: null,
    };
    render(<FindingsFeed />);
    expect(screen.getByText('Postgres refusing connections')).toBeDefined();
    expect(screen.getByText('Disk nearly full')).toBeDefined();
  });

  it('filtered to Open with all findings closed shows the filtered-empty message', () => {
    mockResult = {
      findings: [
        makeFinding({
          id: 1,
          status: 'resolved',
          resolvedAt: new Date('2026-08-16T13:00:00Z'),
          resolution: 'Restarted the database, connections recovered.',
        }),
      ],
      isConnected: true,
      error: null,
    };
    render(<FindingsFeed />);
    expect(screen.getByText('No open findings.')).toBeDefined();
  });

  it('switching to All reveals a closed finding', () => {
    mockResult = {
      findings: [
        makeFinding({
          id: 1,
          status: 'dismissed',
          resolvedAt: new Date('2026-08-16T13:00:00Z'),
          resolution: 'False alarm, routine restart.',
        }),
      ],
      isConnected: true,
      error: null,
    };
    render(<FindingsFeed />);
    expect(screen.getByText('No open findings.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByText('Postgres refusing connections')).toBeDefined();
  });

  it('renders the error state above any findings already held, without clearing them', () => {
    mockResult = {
      findings: [makeFinding({ id: 1 })],
      isConnected: false,
      error: 'stream unavailable',
    };
    render(<FindingsFeed />);
    expect(screen.getByText('Findings stream unavailable')).toBeDefined();
    expect(screen.getByText('Postgres refusing connections')).toBeDefined();
  });

  it('reflects a live update arriving without an explicit reload', () => {
    mockResult = { findings: [makeFinding({ id: 1, occurrences: 1 })], isConnected: true, error: null };
    const { rerender } = render(<FindingsFeed />);
    expect(screen.queryByText('×4')).toBeNull();

    mockResult = { findings: [makeFinding({ id: 1, occurrences: 4 })], isConnected: true, error: null };
    rerender(<FindingsFeed />);

    expect(screen.getByText('×4')).toBeDefined();
  });

  it('shows the connection indicator state', () => {
    mockResult = { findings: [], isConnected: true, error: null };
    const { rerender } = render(<FindingsFeed />);
    expect(screen.getByLabelText('Connected')).toBeDefined();

    mockResult = { findings: [], isConnected: false, error: null };
    rerender(<FindingsFeed />);
    expect(screen.getByLabelText('Disconnected')).toBeDefined();
  });
});

describe('FindingCard', () => {
  it('renders a critical severity with the destructive badge treatment', () => {
    render(<FindingCard finding={makeFinding({ severity: 'critical' })} />);
    const badge = screen.getByText('critical');
    expect(badge.className).toContain('bg-destructive');
  });

  it('renders a warning severity with the warning badge treatment', () => {
    render(<FindingCard finding={makeFinding({ severity: 'warning' })} />);
    const badge = screen.getByText('warning');
    expect(badge.className).toContain('bg-warning');
  });

  it('renders an info severity with the secondary badge treatment', () => {
    render(<FindingCard finding={makeFinding({ severity: 'info' })} />);
    const badge = screen.getByText('info');
    expect(badge.className).toContain('bg-foreground/8');
  });

  it('is collapsed by default and expands on click to reveal detail and evidence', async () => {
    render(<FindingCard finding={makeFinding()} />);
    expect(screen.queryByText('The container logged repeated connection refused errors.')).toBeNull();
    expect(screen.queryByText('FATAL: connection refused')).toBeNull();

    fireEvent.click(screen.getByText('Postgres refusing connections'));

    expect(
      await screen.findByText('The container logged repeated connection refused errors.'),
    ).toBeDefined();
    expect(screen.getByText('FATAL: connection refused')).toBeDefined();
    expect(screen.getByText('postgres-connection-refused')).toBeDefined();
  });

  it('shows the occurrence multiplier only when occurrences exceed one', () => {
    const { rerender } = render(<FindingCard finding={makeFinding({ occurrences: 1 })} />);
    expect(screen.queryByText('×1')).toBeNull();

    rerender(<FindingCard finding={makeFinding({ occurrences: 3 })} />);
    expect(screen.getByText('×3')).toBeDefined();
  });

  it('shows a related subject line for a container finding with a stack entity id', () => {
    render(
      <FindingCard
        finding={makeFinding({ subjectId: 'server-1/abc123', entityIds: ['server-1/abc123', 'server-1/plex'] })}
      />,
    );
    expect(screen.getByText('· server-1/plex')).toBeDefined();
  });

  it('omits the related subject line for a stack finding', () => {
    render(
      <FindingCard
        finding={makeFinding({ subjectKind: 'stack', subjectId: 'server-1/plex', entityIds: [] })}
      />,
    );
    expect(screen.queryByText(/^·/)).toBeNull();
  });

  it('omits the detail paragraph when detail is empty', async () => {
    render(<FindingCard finding={makeFinding({ detail: '' })} />);
    fireEvent.click(screen.getByText('Postgres refusing connections'));
    await waitFor(() => expect(screen.getByText('FATAL: connection refused')).toBeDefined());
    expect(screen.queryByText('The container logged repeated connection refused errors.')).toBeNull();
  });

  it('omits the window line when neither windowFrom nor windowTo is set', async () => {
    render(<FindingCard finding={makeFinding({ windowFrom: null, windowTo: null })} />);
    fireEvent.click(screen.getByText('Postgres refusing connections'));
    await waitFor(() => expect(screen.getByText('FATAL: connection refused')).toBeDefined());
    expect(screen.queryByText(/^Window:/)).toBeNull();
  });

  it('renders an open-ended window with an ellipsis for the missing side', async () => {
    render(<FindingCard finding={makeFinding({ windowFrom: null, windowTo: new Date('2026-08-16T12:00:00Z') })} />);
    fireEvent.click(screen.getByText('Postgres refusing connections'));
    expect(await screen.findByText(/^Window:/)).toBeDefined();
  });

  it('marks truncated evidence with a truncation marker', async () => {
    render(
      <FindingCard
        finding={makeFinding({
          evidence: [
            { kind: 'log_line', at: null, source: '', text: 'partial line', truncated: true },
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByText('Postgres refusing connections'));
    expect(await screen.findByText(/partial line.*truncated/)).toBeDefined();
  });

  it('omits the evidence list when there is no evidence', async () => {
    render(<FindingCard finding={makeFinding({ evidence: [] })} />);
    fireEvent.click(screen.getByText('Postgres refusing connections'));
    await waitFor(() => expect(screen.getByText('postgres-connection-refused')).toBeDefined());
    expect(screen.queryByText('FATAL: connection refused')).toBeNull();
  });

  it('omits the incident id line when there are no incident ids', async () => {
    render(<FindingCard finding={makeFinding({ incidentIds: [] })} />);
    fireEvent.click(screen.getByText('Postgres refusing connections'));
    await waitFor(() => expect(screen.getByText('postgres-connection-refused')).toBeDefined());
    expect(screen.queryByText(/incidents:/)).toBeNull();
  });

  it('renders a resolved finding with its resolution and closed styling', async () => {
    render(
      <FindingCard
        finding={makeFinding({
          status: 'resolved',
          resolvedAt: new Date('2026-08-16T13:00:00Z'),
          resolution: 'Restarted the database, connections recovered.',
        })}
      />,
    );
    expect(screen.getByText('Resolved')).toBeDefined();
    fireEvent.click(screen.getByText('Postgres refusing connections'));
    expect(await screen.findByText(/Restarted the database, connections recovered\./)).toBeDefined();
  });

  it('renders a dismissed finding with the Dismissed label', () => {
    render(
      <FindingCard
        finding={makeFinding({ status: 'dismissed', resolvedAt: new Date(), resolution: 'Routine behaviour.' })}
      />,
    );
    expect(screen.getByText('Dismissed')).toBeDefined();
  });

  it('uses the singular occurrence label at exactly one occurrence', async () => {
    render(<FindingCard finding={makeFinding({ occurrences: 1 })} />);
    fireEvent.click(screen.getByText('Postgres refusing connections'));
    expect(await screen.findByText('1 occurrence')).toBeDefined();
  });

  it('shows incident ids when present', async () => {
    render(<FindingCard finding={makeFinding({ incidentIds: ['inc-e-1', 'inc-e-2'] })} />);
    fireEvent.click(screen.getByText('Postgres refusing connections'));
    expect(await screen.findByText(/incidents: inc-e-1, inc-e-2/)).toBeDefined();
  });
});

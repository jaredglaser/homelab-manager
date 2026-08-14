import { describe, expect, it, mock } from 'bun:test';
import { fireEvent, render, screen } from '@testing-library/react';
import { AiAlertsPanel } from '@/components/ai/AiAlertsPanel';
import { AiContainerTable } from '@/components/ai/AiContainerTable';
import { AiObservationFeed } from '@/components/ai/AiObservationFeed';
import { MarkdownViewerDialog } from '@/components/ai/MarkdownViewerDialog';
import { SeverityBadge } from '@/components/ai/SeverityBadge';
import type { AiAlert, AiAnalysisSession, AiContainerProfile, AiObservation } from '@/types/ai';

function alert(overrides: Partial<AiAlert> = {}): AiAlert {
  return {
    id: 1,
    at: new Date('2026-08-14T10:05:00Z'),
    severity: 'critical',
    title: 'Storage backend down',
    summary: 'Two services failing on the same volume',
    investigation: 'Both started at 10:00',
    entities: ['nuc/media/plex', 'nas/db/postgres'],
    observationIds: [1, 2],
    status: 'open',
    ...overrides,
  };
}

function profile(overrides: Partial<AiContainerProfile> = {}): AiContainerProfile {
  return {
    host: 'nuc',
    containerKey: 'media/plex',
    enabled: true,
    status: 'ready',
    skillMarkdown: '## Format\nline grammar',
    skillVersion: 2,
    sampleStartedAt: null,
    sampleEndedAt: null,
    sampleLineCount: 4200,
    model: 'profiler-70b',
    error: null,
    updatedAt: new Date('2026-08-14T01:00:00Z'),
    ...overrides,
  };
}

function session(overrides: Partial<AiAnalysisSession> = {}): AiAnalysisSession {
  return {
    id: 'session-1',
    host: 'nuc',
    containerKey: 'media/plex',
    day: '2026-08-14',
    status: 'active',
    startedAt: new Date('2026-08-14T00:00:00Z'),
    endedAt: null,
    batchesProcessed: 3,
    linesProcessed: 600,
    runningSummary: null,
    reportMarkdown: null,
    model: 'analyst-8b',
    error: null,
    ...overrides,
  };
}

function observation(overrides: Partial<AiObservation> = {}): AiObservation {
  return {
    id: 1,
    sessionId: 'session-1',
    host: 'nuc',
    containerKey: 'media/plex',
    at: new Date('2026-08-14T10:00:00Z'),
    severity: 'warning',
    title: 'Transcode failures',
    detail: 'Four in a row',
    evidence: ['ERROR transcode failed'],
    triaged: false,
    ...overrides,
  };
}

describe('SeverityBadge', () => {
  it('renders each severity', () => {
    render(
      <>
        <SeverityBadge severity="info" />
        <SeverityBadge severity="notice" />
        <SeverityBadge severity="warning" />
        <SeverityBadge severity="critical" />
      </>,
    );
    expect(screen.getByText('info')).toBeDefined();
    expect(screen.getByText('critical')).toBeDefined();
  });
});

describe('AiAlertsPanel', () => {
  it('says so when nothing is open', () => {
    render(<AiAlertsPanel alerts={[]} onSetStatus={() => {}} />);
    expect(screen.getByText(/Nothing the orchestrator thinks/i)).toBeDefined();
  });

  it('hides alerts that are already handled', () => {
    render(<AiAlertsPanel alerts={[alert({ status: 'acknowledged' })]} onSetStatus={() => {}} />);
    expect(screen.queryByText('Storage backend down')).toBeNull();
  });

  it('renders an open alert with its entities and investigation', () => {
    render(<AiAlertsPanel alerts={[alert()]} onSetStatus={() => {}} />);
    expect(screen.getByText('Storage backend down')).toBeDefined();
    expect(screen.getByText('Both started at 10:00')).toBeDefined();
    expect(screen.getByText('nuc/media/plex')).toBeDefined();
    expect(screen.getByText('nas/db/postgres')).toBeDefined();
  });

  it('omits the investigation block when there is none', () => {
    render(<AiAlertsPanel alerts={[alert({ investigation: null })]} onSetStatus={() => {}} />);
    expect(screen.queryByText('Both started at 10:00')).toBeNull();
  });

  it('reports acknowledge and dismiss', () => {
    const onSetStatus = mock(() => {});
    render(<AiAlertsPanel alerts={[alert()]} onSetStatus={onSetStatus} />);

    fireEvent.click(screen.getByText('Acknowledge'));
    expect(onSetStatus).toHaveBeenCalledWith(1, 'acknowledged');

    fireEvent.click(screen.getByText('Dismiss'));
    expect(onSetStatus).toHaveBeenCalledWith(1, 'dismissed');
  });

  it('disables the controls for the alert being updated', () => {
    render(<AiAlertsPanel alerts={[alert()]} onSetStatus={() => {}} pendingId={1} />);
    expect(screen.getByText('Acknowledge').closest('button')?.disabled).toBe(true);
  });
});

describe('AiContainerTable', () => {
  it('explains an empty fleet', () => {
    render(<AiContainerTable profiles={[]} sessions={[]} onToggle={() => {}} />);
    expect(screen.getByText(/No containers registered yet/i)).toBeDefined();
  });

  it('shows the entity id, skill status and today\'s progress', () => {
    render(<AiContainerTable profiles={[profile()]} sessions={[session()]} onToggle={() => {}} />);
    expect(screen.getByText('nuc/media/plex')).toBeDefined();
    expect(screen.getByText('ready')).toBeDefined();
    expect(screen.getByText('3 batch(es), 600 lines')).toBeDefined();
  });

  it('shows a placeholder when a container has no session yet', () => {
    render(<AiContainerTable profiles={[profile()]} sessions={[]} onToggle={() => {}} />);
    expect(screen.getAllByText('--').length).toBeGreaterThan(0);
  });

  it('surfaces a profiling error', () => {
    render(
      <AiContainerTable
        profiles={[profile({ status: 'failed', error: 'agent unreachable', skillMarkdown: null })]}
        sessions={[]}
        onToggle={() => {}}
      />,
    );
    expect(screen.getByText('agent unreachable')).toBeDefined();
    expect(screen.queryByText('View')).toBeNull();
  });

  it('opens the skill in a viewer', () => {
    render(<AiContainerTable profiles={[profile()]} sessions={[session()]} onToggle={() => {}} />);
    fireEvent.click(screen.getByText('View'));
    expect(screen.getByText(/line grammar/)).toBeDefined();
    expect(screen.getByText(/v2, written by profiler-70b from 4200 sampled lines/)).toBeDefined();
  });

  it('opens the daily report in a viewer', () => {
    render(
      <AiContainerTable
        profiles={[profile()]}
        sessions={[session({ reportMarkdown: '## Summary\nQuiet day.' })]}
        onToggle={() => {}}
      />,
    );
    fireEvent.click(screen.getByText('2026-08-14'));
    expect(screen.getByText(/Quiet day\./)).toBeDefined();
  });

  it('picks the newest session for a container', () => {
    render(
      <AiContainerTable
        profiles={[profile()]}
        sessions={[
          session({ id: 'old', day: '2026-08-13', batchesProcessed: 1, linesProcessed: 10 }),
          session({ id: 'new', day: '2026-08-14', batchesProcessed: 9, linesProcessed: 900 }),
        ]}
        onToggle={() => {}}
      />,
    );
    expect(screen.getByText('9 batch(es), 900 lines')).toBeDefined();
  });

  it('closes the viewer again', () => {
    render(<AiContainerTable profiles={[profile()]} sessions={[session()]} onToggle={() => {}} />);
    fireEvent.click(screen.getByText('View'));
    expect(screen.getByText(/line grammar/)).toBeDefined();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByText(/line grammar/)).toBeNull();
  });

  it('reports the watch toggle', () => {
    const onToggle = mock(() => {});
    render(<AiContainerTable profiles={[profile()]} sessions={[]} onToggle={onToggle} />);
    fireEvent.click(screen.getByLabelText('Watch nuc/media/plex'));
    expect(onToggle).toHaveBeenCalledWith('nuc', 'media/plex', false);
  });
});

describe('AiObservationFeed', () => {
  it('explains silence as the expected outcome', () => {
    render(<AiObservationFeed observations={[]} />);
    expect(screen.getByText(/Analysts stay silent/i)).toBeDefined();
  });

  it('renders an observation with its container and evidence', () => {
    render(<AiObservationFeed observations={[observation()]} />);
    expect(screen.getByText('Transcode failures')).toBeDefined();
    expect(screen.getByText('nuc/media/plex')).toBeDefined();
    expect(screen.getByText('ERROR transcode failed')).toBeDefined();
  });

  it('omits the evidence block when there is none', () => {
    render(<AiObservationFeed observations={[observation({ evidence: [] })]} />);
    expect(screen.queryByText('ERROR transcode failed')).toBeNull();
  });
});

describe('MarkdownViewerDialog', () => {
  it('renders nothing when closed', () => {
    render(
      <MarkdownViewerDialog open={false} onOpenChange={() => {}} title="Skill" content="body" />,
    );
    expect(screen.queryByText('body')).toBeNull();
  });

  it('shows a placeholder for content that was never written', () => {
    render(<MarkdownViewerDialog open onOpenChange={() => {}} title="Skill" content={null} />);
    expect(screen.getByText('Nothing written yet.')).toBeDefined();
  });

  it('renders the optional description', () => {
    render(
      <MarkdownViewerDialog
        open
        onOpenChange={() => {}}
        title="Skill"
        description="v2"
        content="body"
      />,
    );
    expect(screen.getByText('v2')).toBeDefined();
  });
});

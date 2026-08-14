import { describe, it, expect, mock, beforeEach, spyOn } from 'bun:test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { AI_DEFAULTS } from '@/lib/ai/config';
import type { AiAnalysisSnapshot } from '@/types/ai';

const EMPTY: AiAnalysisSnapshot = { profiles: [], sessions: [], observations: [], alerts: [] };

let analysisState = {
  snapshot: EMPTY,
  isConnected: true,
  isLoading: false,
  error: null as Error | null,
};

mock.module('@/hooks/useAiAnalysis', () => ({
  useAiAnalysis: () => analysisState,
}));

const mockSetAlertStatus = mock(async (_input: unknown) => ({ success: true as const }));
const mockSetContainerAnalysis = mock(async (_input: unknown) => ({ success: true as const }));

// The whole module surface is mocked, not just the two functions this page
// calls: `bun test --isolate` still lets a partial module mock leak into
// sibling suites, and a missing export there fails as a hard SyntaxError.
mock.module('@/data/ai/functions', () => ({
  setAlertStatus: mockSetAlertStatus,
  setContainerAnalysis: mockSetContainerAnalysis,
  getAiConfig: mock(async () => ({ provider: null, settings: AI_DEFAULTS })),
  saveAiProvider: mock(async () => ({ provider: null, settings: AI_DEFAULTS })),
  saveAiSettings: mock(async () => ({ provider: null, settings: AI_DEFAULTS })),
  testAiEndpoint: mock(async () => ({ ok: true, models: [], error: null })),
  getAiSnapshot: mock(async () => EMPTY),
}));

const { Route } = await import('@/routes/ai');
const AiPage = Route.options.component as () => ReactElement;

function populated(): AiAnalysisSnapshot {
  return {
    profiles: [
      {
        host: 'nuc',
        containerKey: 'media/plex',
        enabled: true,
        status: 'ready',
        skillMarkdown: '## Format',
        skillVersion: 1,
        sampleStartedAt: null,
        sampleEndedAt: null,
        sampleLineCount: 100,
        model: 'profiler-70b',
        error: null,
        updatedAt: new Date('2026-08-14T01:00:00Z'),
      },
    ],
    sessions: [
      {
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
      },
    ],
    observations: [],
    alerts: [
      {
        id: 7,
        at: new Date('2026-08-14T10:05:00Z'),
        severity: 'critical',
        title: 'Storage backend down',
        summary: 'Two services failing',
        investigation: null,
        entities: ['nuc/media/plex'],
        observationIds: [1],
        status: 'open',
      },
    ],
  };
}

describe('/ai route', () => {
  beforeEach(() => {
    analysisState = { snapshot: EMPTY, isConnected: true, isLoading: false, error: null };
    mockSetAlertStatus.mockClear();
    mockSetContainerAnalysis.mockClear();
  });

  it('shows a loading state before the first snapshot', () => {
    analysisState = { ...analysisState, isLoading: true };
    render(<AiPage />);
    expect(screen.getByText(/Loading fleet analysis/i)).toBeDefined();
  });

  it('shows the stream error instead of the panels', () => {
    analysisState = { ...analysisState, error: new Error('db down') };
    render(<AiPage />);
    expect(screen.getByText(/Failed to connect to the AI analysis stream: db down/)).toBeDefined();
    expect(screen.queryByText('Containers')).toBeNull();
  });

  it('summarises the fleet in the status bar', () => {
    analysisState = { ...analysisState, snapshot: populated() };
    render(<AiPage />);
    expect(screen.getByText('1 container(s)')).toBeDefined();
    expect(screen.getByText('1 active session(s)')).toBeDefined();
    expect(screen.getByText('1 open alert(s)')).toBeDefined();
    expect(screen.getByText('live')).toBeDefined();
  });

  it('hides the alert count when nothing is open', () => {
    render(<AiPage />);
    expect(screen.queryByText(/open alert\(s\)/)).toBeNull();
  });

  it('reports a disconnected stream', () => {
    analysisState = { ...analysisState, isConnected: false };
    render(<AiPage />);
    expect(screen.getByText('disconnected')).toBeDefined();
  });

  it('acknowledges an alert through the server function', async () => {
    analysisState = { ...analysisState, snapshot: populated() };
    render(<AiPage />);

    fireEvent.click(screen.getByText('Acknowledge'));
    await waitFor(() =>
      expect(mockSetAlertStatus).toHaveBeenCalledWith({ data: { id: 7, status: 'acknowledged' } }),
    );
  });

  it('logs rather than throwing when an alert update fails', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    mockSetAlertStatus.mockImplementationOnce(async () => {
      throw new Error('not an operator');
    });
    analysisState = { ...analysisState, snapshot: populated() };
    render(<AiPage />);

    fireEvent.click(screen.getByText('Dismiss'));
    await waitFor(() => expect(errorSpy).toHaveBeenCalled());
    errorSpy.mockRestore();
  });

  it('logs rather than throwing when a container toggle fails', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    mockSetContainerAnalysis.mockImplementationOnce(async () => {
      throw new Error('not an operator');
    });
    analysisState = { ...analysisState, snapshot: populated() };
    render(<AiPage />);

    fireEvent.click(screen.getByLabelText('Watch nuc/media/plex'));
    await waitFor(() => expect(errorSpy).toHaveBeenCalled());
    errorSpy.mockRestore();
  });

  it('toggles a container through the server function', async () => {
    analysisState = { ...analysisState, snapshot: populated() };
    render(<AiPage />);

    fireEvent.click(screen.getByLabelText('Watch nuc/media/plex'));
    await waitFor(() =>
      expect(mockSetContainerAnalysis).toHaveBeenCalledWith({
        data: { host: 'nuc', containerKey: 'media/plex', enabled: false },
      }),
    );
  });
});

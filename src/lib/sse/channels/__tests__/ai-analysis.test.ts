import { describe, it, expect } from 'bun:test';
import { aiAnalysisChannel, serializeAiAnalysisSnapshot } from '@/lib/sse/channels/ai-analysis';
import type { AiAnalysisSnapshot } from '@/types/ai';

const wireSnapshot = {
  profiles: [
    {
      host: 'nuc',
      containerKey: 'media/plex',
      enabled: true,
      status: 'ready',
      skillMarkdown: '## Format',
      skillVersion: 2,
      sampleStartedAt: '2026-08-07T00:00:00.000Z',
      sampleEndedAt: '2026-08-14T00:00:00.000Z',
      sampleLineCount: 4200,
      model: 'profiler-70b',
      error: null,
      updatedAt: '2026-08-14T01:00:00.000Z',
    },
  ],
  sessions: [
    {
      id: 'session-1',
      host: 'nuc',
      containerKey: 'media/plex',
      day: '2026-08-14',
      status: 'active',
      startedAt: '2026-08-14T00:00:00.000Z',
      endedAt: null,
      batchesProcessed: 3,
      linesProcessed: 600,
      runningSummary: 'quiet',
      reportMarkdown: null,
      model: 'analyst-8b',
      error: null,
    },
  ],
  observations: [
    {
      id: 17,
      sessionId: 'session-1',
      host: 'nuc',
      containerKey: 'media/plex',
      at: '2026-08-14T10:00:00.000Z',
      severity: 'warning',
      title: 'Transcode failures',
      detail: 'Four in a row',
      evidence: ['ERROR'],
      triaged: false,
    },
  ],
  alerts: [
    {
      id: 5,
      at: '2026-08-14T10:05:00.000Z',
      severity: 'critical',
      title: 'Storage down',
      summary: 'Two services failing',
      investigation: null,
      entities: ['nuc/media/plex'],
      observationIds: [17],
      status: 'open',
    },
  ],
};

describe('aiAnalysisChannel', () => {
  it('points at the route the server handler registers', () => {
    expect(aiAnalysisChannel.url).toBe('/api/ai-analysis');
    expect(aiAnalysisChannel.errorEvent).toBe('ai_analysis_error');
  });

  it('accepts a well-formed snapshot', () => {
    expect(aiAnalysisChannel.schema.safeParse(wireSnapshot).success).toBe(true);
  });

  it('rejects an unknown severity', () => {
    const bad = {
      ...wireSnapshot,
      observations: [{ ...wireSnapshot.observations[0], severity: 'catastrophic' }],
    };
    expect(aiAnalysisChannel.schema.safeParse(bad).success).toBe(false);
  });

  it('rejects a snapshot missing a list', () => {
    const { alerts: _alerts, ...incomplete } = wireSnapshot;
    expect(aiAnalysisChannel.schema.safeParse(incomplete).success).toBe(false);
  });

  it('revives every timestamp the wire carries as a string', () => {
    const parsed = aiAnalysisChannel.schema.parse(wireSnapshot);
    const revived = aiAnalysisChannel.revive!(parsed);

    expect(revived.profiles[0].updatedAt).toBeInstanceOf(Date);
    expect(revived.profiles[0].sampleStartedAt).toBeInstanceOf(Date);
    expect(revived.sessions[0].startedAt).toBeInstanceOf(Date);
    expect(revived.sessions[0].endedAt).toBeNull();
    expect(revived.observations[0].at.toISOString()).toBe('2026-08-14T10:00:00.000Z');
    expect(revived.alerts[0].at).toBeInstanceOf(Date);
  });

  it('leaves the calendar day as a string, not a Date', () => {
    const revived = aiAnalysisChannel.revive!(aiAnalysisChannel.schema.parse(wireSnapshot));
    expect(revived.sessions[0].day).toBe('2026-08-14');
  });
});

describe('serializeAiAnalysisSnapshot', () => {
  it('emits a default SSE data frame', () => {
    const snapshot: AiAnalysisSnapshot = {
      profiles: [],
      sessions: [],
      observations: [],
      alerts: [],
    };
    const frame = serializeAiAnalysisSnapshot(snapshot);
    expect(frame.startsWith('data: ')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
    expect(JSON.parse(frame.slice(6))).toEqual(snapshot);
  });

  it('round-trips through the channel schema', () => {
    const frame = serializeAiAnalysisSnapshot(
      aiAnalysisChannel.revive!(aiAnalysisChannel.schema.parse(wireSnapshot)),
    );
    expect(aiAnalysisChannel.schema.safeParse(JSON.parse(frame.slice(6))).success).toBe(true);
  });
});

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { Pool } from 'pg';
import { AI_ANALYSIS_NOTIFY_CHANNEL, AiAnalysisRepository } from '../ai-analysis-repository';

interface MockPool {
  query: ReturnType<typeof mock>;
  results: { rows: unknown[] }[];
}

function mockPool(): MockPool {
  const results: { rows: unknown[] }[] = [];
  const query = mock(() => Promise.resolve(results.shift() ?? { rows: [] }));
  return { query, results } as unknown as MockPool;
}

function profileRow(overrides: Record<string, unknown> = {}) {
  return {
    host: 'nuc',
    container_key: 'media/plex',
    enabled: true,
    status: 'ready',
    skill_markdown: '## Format',
    skill_version: '2',
    sample_started_at: new Date('2026-08-07T00:00:00Z'),
    sample_ended_at: new Date('2026-08-14T00:00:00Z'),
    sample_line_count: '4200',
    model: 'profiler-70b',
    error: null,
    updated_at: new Date('2026-08-14T01:00:00Z'),
    ...overrides,
  };
}

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    host: 'nuc',
    container_key: 'media/plex',
    day: '2026-08-14',
    status: 'active',
    started_at: new Date('2026-08-14T00:00:00Z'),
    ended_at: null,
    batches_processed: '3',
    lines_processed: '600',
    running_summary: 'quiet',
    report_markdown: null,
    model: 'analyst-8b',
    error: null,
    ...overrides,
  };
}

function observationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '17',
    session_id: 'session-1',
    host: 'nuc',
    container_key: 'media/plex',
    at: new Date('2026-08-14T10:00:00Z'),
    severity: 'warning',
    title: 'Transcode failures',
    detail: 'Four in a row',
    evidence: ['ERROR'],
    triaged: false,
    ...overrides,
  };
}

function alertRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '5',
    at: new Date('2026-08-14T10:05:00Z'),
    severity: 'critical',
    title: 'Storage down',
    summary: 'Two services failing',
    investigation: null,
    entities: ['nuc/media/plex'],
    observation_ids: ['17', '18'],
    status: 'open',
    ...overrides,
  };
}

describe('AiAnalysisRepository', () => {
  let pool: MockPool;
  let repo: AiAnalysisRepository;

  beforeEach(() => {
    pool = mockPool();
    repo = new AiAnalysisRepository(pool as unknown as Pool);
  });

  it('exposes the notify channel the broadcast service listens on', () => {
    expect(AI_ANALYSIS_NOTIFY_CHANNEL).toBe('ai_analysis_change');
  });

  it('listProfiles converts counters out of their BIGINT strings', async () => {
    pool.results.push({ rows: [profileRow()] });
    const [profile] = await repo.listProfiles();
    expect(profile.skillVersion).toBe(2);
    expect(profile.sampleLineCount).toBe(4200);
    expect(profile.enabled).toBe(true);
  });

  it('listProfiles tolerates nulls in the optional columns', async () => {
    pool.results.push({
      rows: [
        profileRow({
          skill_markdown: null,
          sample_started_at: null,
          sample_ended_at: null,
          model: null,
          error: null,
        }),
      ],
    });
    const [profile] = await repo.listProfiles();
    expect(profile.skillMarkdown).toBeNull();
    expect(profile.sampleStartedAt).toBeNull();
    expect(profile.model).toBeNull();
  });

  it('getProfile returns null when the row is missing', async () => {
    expect(await repo.getProfile('nuc', 'media/plex')).toBeNull();
  });

  it('ensureProfile inserts then reads back the row', async () => {
    pool.results.push({ rows: [] }, { rows: [profileRow()] });
    const profile = await repo.ensureProfile('nuc', 'media/plex');
    expect(profile.containerKey).toBe('media/plex');
    expect(pool.query.mock.calls[0][0]).toContain('ON CONFLICT (host, container_key) DO NOTHING');
  });

  it('ensureProfile fails loudly if the row vanishes after insert', async () => {
    pool.results.push({ rows: [] }, { rows: [] });
    await expect(repo.ensureProfile('nuc', 'media/plex')).rejects.toThrow('vanished');
  });

  it('setProfileStatus and setProfileEnabled pass their arguments through', async () => {
    await repo.setProfileStatus('nuc', 'media/plex', 'failed', 'boom');
    expect(pool.query.mock.calls[0][1]).toEqual(['nuc', 'media/plex', 'failed', 'boom']);

    await repo.setProfileStatus('nuc', 'media/plex', 'profiling');
    expect(pool.query.mock.calls[1][1]).toEqual(['nuc', 'media/plex', 'profiling', null]);

    await repo.setProfileEnabled('nuc', 'media/plex', false);
    expect(pool.query.mock.calls[2][1]).toEqual(['nuc', 'media/plex', false]);
  });

  it('saveSkill bumps the version and marks the profile ready', async () => {
    await repo.saveSkill({
      host: 'nuc',
      containerKey: 'media/plex',
      skillMarkdown: '## Format',
      model: 'profiler-70b',
      sampleStartedAt: new Date(0),
      sampleEndedAt: new Date(1000),
      sampleLineCount: 42,
    });
    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toContain('skill_version = skill_version + 1');
    expect(sql).toContain("status = 'ready'");
  });

  it('openSession is idempotent for the same day', async () => {
    pool.results.push({ rows: [] }, { rows: [sessionRow()] });
    const session = await repo.openSession('nuc', 'media/plex', '2026-08-14', 'analyst-8b');
    expect(session.day).toBe('2026-08-14');
    expect(session.batchesProcessed).toBe(3);
    expect(session.linesProcessed).toBe(600);
    expect(pool.query.mock.calls[0][0]).toContain('ON CONFLICT (host, container_key, day) DO NOTHING');
  });

  it('openSession fails loudly if the row vanishes after insert', async () => {
    pool.results.push({ rows: [] }, { rows: [] });
    await expect(repo.openSession('nuc', 'media/plex', '2026-08-14', 'm')).rejects.toThrow('vanished');
  });

  it('formats a DATE returned as a local-midnight Date without shifting the day', async () => {
    pool.results.push({ rows: [] }, { rows: [sessionRow({ day: new Date(2026, 7, 14) })] });
    const session = await repo.openSession('nuc', 'media/plex', '2026-08-14', 'm');
    expect(session.day).toBe('2026-08-14');
  });

  it('recordBatch increments counters and only overwrites a non-null summary', async () => {
    await repo.recordBatch('session-1', 200, 'new summary');
    expect(pool.query.mock.calls[0][1]).toEqual(['session-1', 200, 'new summary']);
    expect(pool.query.mock.calls[0][0]).toContain('COALESCE($3, running_summary)');
  });

  it('closeSession and failSession set terminal state', async () => {
    await repo.closeSession('session-1', '## Summary');
    expect(pool.query.mock.calls[0][0]).toContain("status = 'closed'");

    await repo.failSession('session-1', 'model unreachable');
    expect(pool.query.mock.calls[1][0]).toContain("status = 'failed'");
  });

  it('listSessions applies the limit', async () => {
    pool.results.push({ rows: [sessionRow()] });
    await repo.listSessions(5);
    expect(pool.query.mock.calls[0][1]).toEqual([5]);
  });

  it('addObservation serializes evidence as JSON and returns the stored row', async () => {
    pool.results.push({ rows: [observationRow()] });
    const observation = await repo.addObservation({
      sessionId: 'session-1',
      host: 'nuc',
      containerKey: 'media/plex',
      severity: 'warning',
      title: 'Transcode failures',
      detail: 'Four in a row',
      evidence: ['ERROR'],
    });
    expect(observation.id).toBe(17);
    expect(observation.evidence).toEqual(['ERROR']);
    expect((pool.query.mock.calls[0][1] as unknown[])[6]).toBe('["ERROR"]');
  });

  it('claimUntriaged marks rows and returns them oldest first', async () => {
    pool.results.push({
      rows: [
        observationRow({ id: '2', at: new Date('2026-08-14T11:00:00Z') }),
        observationRow({ id: '1', at: new Date('2026-08-14T10:00:00Z') }),
      ],
    });
    const claimed = await repo.claimUntriaged();
    expect(claimed.map((o) => o.id)).toEqual([1, 2]);
    expect(pool.query.mock.calls[0][0]).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('listObservations defaults evidence to an empty array', async () => {
    pool.results.push({ rows: [observationRow({ evidence: null })] });
    const [observation] = await repo.listObservations();
    expect(observation.evidence).toEqual([]);
  });

  it('addAlert converts BIGINT observation ids to numbers', async () => {
    pool.results.push({ rows: [alertRow()] });
    const alert = await repo.addAlert({
      severity: 'critical',
      title: 'Storage down',
      summary: 'Two services failing',
      investigation: null,
      entities: ['nuc/media/plex'],
      observationIds: [17, 18],
    });
    expect(alert.id).toBe(5);
    expect(alert.observationIds).toEqual([17, 18]);
  });

  it('listAlerts defaults array columns when the driver returns null', async () => {
    pool.results.push({ rows: [alertRow({ entities: null, observation_ids: null })] });
    const [alert] = await repo.listAlerts();
    expect(alert.entities).toEqual([]);
    expect(alert.observationIds).toEqual([]);
  });

  it('setAlertStatus updates by id', async () => {
    await repo.setAlertStatus(5, 'acknowledged');
    expect(pool.query.mock.calls[0][1]).toEqual([5, 'acknowledged']);
  });
});

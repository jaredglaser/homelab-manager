import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { Pool } from 'pg';
import { AnsibleRunRepository } from '../ansible-run-repository';

interface MockPool {
  query: ReturnType<typeof mock>;
  results: Array<{ rows: unknown[]; rowCount?: number }>;
}

function mockPool(): MockPool {
  const results: Array<{ rows: unknown[]; rowCount?: number }> = [];
  const query = mock(() => Promise.resolve(results.shift() ?? { rows: [] }));
  return { query, results } as unknown as MockPool;
}

const row = {
  id: '7',
  run_id: 'run-1',
  playbook: 'host_baseline.yml',
  hosts: ['host-a'],
  check_mode: true,
  status: 'running',
  requested_by: 'admin@example.test',
  summaries: [{ host: 'host-a', ok: 1, changed: 0, failures: 0, unreachable: 0, skipped: 0, outcome: 'ok' }],
  created_at: new Date('2026-01-01T00:00:00Z'),
  finished_at: null,
};

describe('AnsibleRunRepository', () => {
  let pool: MockPool;
  let repo: AnsibleRunRepository;

  beforeEach(() => {
    pool = mockPool();
    repo = new AnsibleRunRepository(pool as unknown as Pool);
  });

  it('creates a run and coerces the BIGSERIAL id to a number', async () => {
    pool.results.push({ rows: [row] });
    const run = await repo.create({
      runId: 'run-1',
      playbook: 'host_baseline.yml',
      hosts: ['host-a'],
      checkMode: true,
      requestedBy: 'admin@example.test',
    });

    expect(run.id).toBe(7);
    expect(run.checkMode).toBe(true);
    expect(run.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(run.finishedAt).toBeNull();
    expect(pool.query.mock.calls[0][1]).toEqual([
      'run-1',
      'host_baseline.yml',
      ['host-a'],
      true,
      'admin@example.test',
    ]);
  });

  it('defaults absent hosts and summaries rather than emitting undefined', async () => {
    pool.results.push({ rows: [{ ...row, hosts: null, summaries: null, finished_at: new Date('2026-01-01T01:00:00Z') }] });
    const run = await repo.create({
      runId: 'run-1',
      playbook: 'p.yml',
      hosts: [],
      checkMode: false,
      requestedBy: 'a',
    });

    expect(run.hosts).toEqual([]);
    expect(run.summaries).toEqual([]);
    expect(run.finishedAt).toBe('2026-01-01T01:00:00.000Z');
  });

  it('appends an event keyed on the run and its counter', async () => {
    await repo.appendEvent(7, { kind: 'play_start', counter: 3, play: 'Host baseline' });
    expect(pool.query.mock.calls[0][1]).toEqual([
      7,
      3,
      JSON.stringify({ kind: 'play_start', counter: 3, play: 'Host baseline' }),
    ]);
  });

  it('finishes and sets status', async () => {
    await repo.finish(7, 'succeeded', []);
    expect(pool.query.mock.calls[0][1]).toEqual([7, 'succeeded', '[]']);

    await repo.setStatus(7, 'running');
    expect(pool.query.mock.calls[1][1]).toEqual([7, 'running']);
  });

  it('lists recent runs and looks one up by run id', async () => {
    pool.results.push({ rows: [row] });
    expect(await repo.findRecent(5)).toHaveLength(1);
    expect(pool.query.mock.calls[0][1]).toEqual([5]);

    pool.results.push({ rows: [row] });
    expect((await repo.findByRunId('run-1'))?.runId).toBe('run-1');

    pool.results.push({ rows: [] });
    expect(await repo.findByRunId('missing')).toBeNull();
  });

  it('reports how many stranded runs it failed, treating a null rowCount as zero', async () => {
    pool.results.push({ rows: [], rowCount: 3 });
    expect(await repo.failStrandedRuns()).toBe(3);

    pool.results.push({ rows: [] });
    expect(await repo.failStrandedRuns()).toBe(0);
  });
});

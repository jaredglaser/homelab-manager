import { describe, it, expect, mock, spyOn, afterEach } from 'bun:test';
import {
  ANSIBLE_SECRET_SCOPE,
  handleStartRun,
  handleListRuns,
  handleCancelRun,
  handleGetLatestRun,
} from '@/data/ansible/handlers';
import type { AnsibleRunService } from '@/lib/ansible/run-service';
import type { AnsibleRunRepository } from '@/lib/database/repositories/ansible-run-repository';
import type { AnsibleRun } from '@/types/ansible';

const run: AnsibleRun = {
  id: 1,
  runId: 'run-1',
  playbook: 'host_baseline.yml',
  hosts: ['host-a'],
  checkMode: true,
  status: 'pending',
  requestedBy: 'admin@example.test',
  summaries: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  finishedAt: null,
};

const request = {
  playbook: 'host_baseline.yml',
  hosts: ['host-a'],
  checkMode: true,
  requestedBy: 'admin@example.test',
};

function makeDeps(overrides: Record<string, unknown> = {}) {
  const service = {
    start: mock(async () => run),
    consume: mock(async () => 'succeeded' as const),
    cancel: mock(async () => {}),
  };
  const repo = {
    findRecent: mock(async () => [run]),
    findLatest: mock(async (): Promise<AnsibleRun | null> => run),
    findEvents: mock(async () => [{ kind: 'play_start', counter: 1, play: 'Host baseline' }]),
  };
  return {
    service: service as unknown as AnsibleRunService,
    repo: repo as unknown as AnsibleRunRepository,
    loadSecrets: mock(async () => ({ hlm_baseline_secret: 'shh' })),
    spies: { service, repo },
    ...overrides,
  };
}

describe('handleStartRun', () => {
  afterEach(() => {
    mock.restore();
  });

  it('passes secrets from the reserved scope through as extravars', async () => {
    const deps = makeDeps();
    const started: AnsibleRun[] = [];

    expect(await handleStartRun(request, { ...deps, onStarted: (r) => started.push(r) })).toEqual(run);
    expect(deps.loadSecrets).toHaveBeenCalled();
    expect(deps.spies.service.start).toHaveBeenCalledWith({
      ...request,
      extravars: { hlm_baseline_secret: 'shh' },
    });
    expect(started).toEqual([run]);
  });

  it('drains the run in the background by default', async () => {
    const deps = makeDeps();
    await handleStartRun(request, deps);
    expect(deps.spies.service.consume).toHaveBeenCalledWith(run);
  });

  it('logs rather than rejects when the background drain fails', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    const deps = makeDeps();
    (deps.spies.service.consume as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new Error('stream gone');
    });

    await handleStartRun(request, deps);
    await Promise.resolve();
    await Promise.resolve();

    expect(consoleError).toHaveBeenCalled();
  });

  it('names a reserved scope that cannot collide with a stack', () => {
    expect(ANSIBLE_SECRET_SCOPE).toBe('__ansible__');
  });
});

describe('handleListRuns and handleCancelRun', () => {
  it('lists recent runs at the requested limit', async () => {
    const deps = makeDeps();
    expect(await handleListRuns(20, deps)).toEqual([run]);
    expect(deps.spies.repo.findRecent).toHaveBeenCalledWith(20);
  });

  it('cancels through the service', async () => {
    const deps = makeDeps();
    expect(await handleCancelRun('run-1', deps)).toEqual({ cancelled: true });
    expect(deps.spies.service.cancel).toHaveBeenCalledWith('run-1');
  });
});

describe('handleGetLatestRun', () => {
  it('pairs the newest run with its persisted events', async () => {
    const deps = makeDeps();
    expect(await handleGetLatestRun(deps)).toEqual({
      run,
      events: [{ kind: 'play_start', counter: 1, play: 'Host baseline' }],
    });
    expect(deps.spies.repo.findEvents).toHaveBeenCalledWith(run.id);
  });

  it('returns null and reads no events when no run exists', async () => {
    const deps = makeDeps();
    deps.spies.repo.findLatest.mockImplementation(async () => null);
    expect(await handleGetLatestRun(deps)).toBeNull();
    expect(deps.spies.repo.findEvents).not.toHaveBeenCalled();
  });
});

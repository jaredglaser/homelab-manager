import { describe, it, expect, mock, spyOn, afterEach } from 'bun:test';
import { AnsibleRunService } from '@/lib/ansible/run-service';
import type { AnsibleBroadcastEvent } from '@/lib/ansible/run-broadcast-service';
import type { SidecarClient } from '@/lib/ansible/sidecar-client';
import type { AnsibleRunRepository } from '@/lib/database/repositories/ansible-run-repository';
import type { AnsibleRun } from '@/types/ansible';

const record: AnsibleRun = {
  id: 42,
  runId: 'run-1',
  playbook: 'host_baseline.yml',
  hosts: ['host-a', 'host-b'],
  checkMode: false,
  status: 'pending',
  requestedBy: 'admin@example.test',
  summaries: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  finishedAt: null,
};

function makeRepo() {
  return {
    create: mock(async () => record),
    appendEvent: mock(async () => {}),
    finish: mock(async () => {}),
  };
}

function makeClient(events: unknown[] = [], overrides: Record<string, unknown> = {}) {
  return {
    startRun: mock(async () => {}),
    cancelRun: mock(async () => {}),
    streamEvents: mock(async function* () {
      for (const event of events) yield event;
    }),
    ...overrides,
  };
}

function makeService(repo: ReturnType<typeof makeRepo>, client: ReturnType<typeof makeClient>) {
  const published: AnsibleBroadcastEvent[] = [];
  const service = new AnsibleRunService({
    repo: repo as unknown as AnsibleRunRepository,
    client: client as unknown as SidecarClient,
    publish: (event) => published.push(event),
    newRunId: () => 'run-1',
  });
  return { service, published };
}

const startInput = {
  playbook: 'host_baseline.yml',
  hosts: ['host-a', 'host-b'],
  checkMode: false,
  requestedBy: 'admin@example.test',
  extravars: { hlm_baseline_secret: 'shh' },
};

describe('AnsibleRunService.start', () => {
  afterEach(() => {
    mock.restore();
  });

  it('records the run, dispatches it, and announces it', async () => {
    const repo = makeRepo();
    const client = makeClient();
    const { service, published } = makeService(repo, client);

    expect(await service.start(startInput)).toEqual(record);
    expect(repo.create).toHaveBeenCalledWith({
      runId: 'run-1',
      playbook: 'host_baseline.yml',
      hosts: ['host-a', 'host-b'],
      checkMode: false,
      requestedBy: 'admin@example.test',
    });
    expect(client.startRun).toHaveBeenCalledWith({
      runId: 'run-1',
      playbook: 'host_baseline.yml',
      hosts: ['host-a', 'host-b'],
      check: false,
      extravars: { hlm_baseline_secret: 'shh' },
    });
    expect(published).toEqual([
      {
        type: 'run_started',
        runId: 'run-1',
        playbook: 'host_baseline.yml',
        hosts: ['host-a', 'host-b'],
        checkMode: false,
      },
    ]);
  });

  it('fails and closes out the record when the sidecar rejects the dispatch', async () => {
    const repo = makeRepo();
    const client = makeClient([], {
      startRun: mock(async () => {
        throw new Error('hosts already running: host-a');
      }),
    });
    const { service, published } = makeService(repo, client);

    await expect(service.start(startInput)).rejects.toThrow('hosts already running');
    expect(repo.finish).toHaveBeenCalledWith(42, 'failed', []);
    expect(published).toEqual([{ type: 'run_finished', runId: 'run-1', status: 'failed' }]);
  });

  it('generates a run id when none is injected', async () => {
    const repo = makeRepo();
    const service = new AnsibleRunService({
      repo: repo as unknown as AnsibleRunRepository,
      client: makeClient() as unknown as SidecarClient,
      publish: () => {},
    });

    await service.start(startInput);
    const created = repo.create.mock.calls[0] as unknown as [{ runId: string }];
    expect(created[0].runId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('AnsibleRunService.consume', () => {
  afterEach(() => {
    mock.restore();
  });

  it('persists normalized events, drops the rest, and closes on the runner status', async () => {
    const repo = makeRepo();
    const client = makeClient([
      { event: 'playbook_on_task_start', counter: 1, event_data: { task: 'Install' } },
      { event: 'verbose', counter: 2 },
      { event: 'runner_on_ok', counter: 3, event_data: { host: 'host-a' } },
      {
        event: 'playbook_on_stats',
        counter: 4,
        event_data: { ok: { 'host-a': 1 }, dark: { 'host-b': 1 } },
      },
      { event: 'runner_status', status: 'successful' },
    ]);
    const { service, published } = makeService(repo, client);

    expect(await service.consume(record)).toBe('succeeded');
    expect(repo.appendEvent).toHaveBeenCalledTimes(4);
    expect(published.filter((e) => e.type === 'run_event')).toHaveLength(4);
    expect(repo.finish).toHaveBeenCalledWith(
      42,
      'succeeded',
      [
        { host: 'host-a', ok: 1, changed: 0, failures: 0, unreachable: 0, skipped: 0, outcome: 'ok' },
        { host: 'host-b', ok: 0, changed: 0, failures: 0, unreachable: 1, skipped: 0, outcome: 'unreachable' },
      ],
    );
    expect(published.at(-1)).toEqual({ type: 'run_finished', runId: 'run-1', status: 'succeeded' });
  });

  it('derives a terminal status from the summaries when the stream ends without one', async () => {
    const repo = makeRepo();
    const client = makeClient([
      { event: 'playbook_on_stats', counter: 1, event_data: { failures: { 'host-a': 1 } } },
    ]);
    const { service } = makeService(repo, client);

    expect(await service.consume(record)).toBe('failed');
  });

  it('reports an unreachable-only run as succeeded, so one sleeping host is not a red run', async () => {
    const repo = makeRepo();
    const client = makeClient([
      {
        event: 'playbook_on_stats',
        counter: 1,
        event_data: { ok: { 'host-a': 3 }, dark: { 'host-b': 1 } },
      },
    ]);
    const { service } = makeService(repo, client);

    expect(await service.consume(record)).toBe('succeeded');
  });

  it('fails the run when the stream itself errors, without throwing at the caller', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    const repo = makeRepo();
    const client = makeClient([], {
      streamEvents: mock(async function* () {
        yield { event: 'playbook_on_task_start', counter: 1, event_data: { task: 'Install' } };
        throw new Error('connection reset');
      }),
    });
    const { service } = makeService(repo, client);

    expect(await service.consume(record)).toBe('failed');
    expect(consoleError).toHaveBeenCalled();
  });

  it('keeps a cancelled status rather than recomputing it from the summaries', async () => {
    const repo = makeRepo();
    const client = makeClient([
      { event: 'playbook_on_stats', counter: 1, event_data: { ok: { 'host-a': 1 } } },
      { event: 'runner_status', status: 'canceled' },
    ]);
    const { service } = makeService(repo, client);

    expect(await service.consume(record)).toBe('cancelled');
  });
});

describe('AnsibleRunService.cancel', () => {
  it('delegates to the sidecar', async () => {
    const client = makeClient();
    const { service } = makeService(makeRepo(), client);
    await service.cancel('run-1');
    expect(client.cancelRun).toHaveBeenCalledWith('run-1');
  });
});

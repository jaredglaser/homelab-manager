import { describe, it, expect, spyOn } from 'bun:test';
import {
  FINISHED_JOB_RETENTION_MS,
  TlsProvisioningJobs,
  UNEXPECTED_TLS_FAILURE_MESSAGE,
  type TlsProvisioningOutcome,
  type TlsProvisioningSnapshot,
} from '../tls-provisioning-jobs';
import { zTlsProvisioningSnapshotWire } from '@/lib/channels/tls-provisioning';

const OK: TlsProvisioningOutcome = { ok: true, agentUrl: 'https://10.0.0.5:9090', enrolledOverPlainHttp: false, fingerprint: 'SHA256:abc' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeJobs(start = Date.parse('2026-11-25T10:00:00.000Z')) {
  let clock = start;
  let ids = 0;
  const jobs = new TlsProvisioningJobs({ now: () => clock, newJobId: () => `job-${++ids}` });
  return { jobs, advance: (ms: number) => { clock += ms; } };
}

/** Resolves with the first snapshot that matches, so a test waits on the publish itself. */
function nextSnapshot(jobs: TlsProvisioningJobs, match: (s: TlsProvisioningSnapshot) => boolean): Promise<TlsProvisioningSnapshot> {
  return new Promise((resolve) => {
    jobs.subscribe((snapshot) => {
      if (match(snapshot)) resolve(snapshot);
    });
  });
}

describe('TlsProvisioningJobs', () => {
  it('sends the current snapshot on subscribe', () => {
    const { jobs } = makeJobs();
    const seen: TlsProvisioningSnapshot[] = [];
    jobs.subscribe((s) => seen.push(s));
    expect(seen).toEqual([{ jobs: [] }]);
  });

  it('publishes the job as running, then finished with the outcome the run returned', async () => {
    const { jobs, advance } = makeJobs();
    const run = deferred<TlsProvisioningOutcome>();
    const seen: TlsProvisioningSnapshot[] = [];
    jobs.subscribe((s) => seen.push(s));

    expect(jobs.start(7, () => run.promise)).toEqual({ jobId: 'job-1', joined: false });
    expect(seen.at(-1)?.jobs).toEqual([
      { jobId: 'job-1', hostId: 7, state: 'running', startedAt: '2026-11-25T10:00:00.000Z', finishedAt: null, outcome: null },
    ]);

    advance(16_000);
    const finished = nextSnapshot(jobs, (s) => s.jobs[0]?.state === 'finished');
    run.resolve(OK);
    expect((await finished).jobs).toEqual([
      { jobId: 'job-1', hostId: 7, state: 'finished', startedAt: '2026-11-25T10:00:00.000Z', finishedAt: '2026-11-25T10:00:16.000Z', outcome: OK },
    ]);
  });

  it('joins the running job for a host instead of starting a second run', () => {
    const { jobs } = makeJobs();
    let runs = 0;
    const pending = new Promise<TlsProvisioningOutcome>(() => undefined);
    const run = () => {
      runs++;
      return pending;
    };
    jobs.start(7, run);
    expect(jobs.start(7, run)).toEqual({ jobId: 'job-1', joined: true });
    expect(runs).toBe(1);
  });

  it('runs hosts independently', () => {
    const { jobs } = makeJobs();
    const pending = () => new Promise<TlsProvisioningOutcome>(() => undefined);
    jobs.start(7, pending);
    expect(jobs.start(8, pending)).toEqual({ jobId: 'job-2', joined: false });
    expect(jobs.snapshot().jobs.map((j) => [j.hostId, j.state])).toEqual([[7, 'running'], [8, 'running']]);
  });

  it('starts a new job once the previous one for the host has finished', async () => {
    const { jobs } = makeJobs();
    const finished = nextSnapshot(jobs, (s) => s.jobs[0]?.state === 'finished');
    jobs.start(7, () => Promise.resolve(OK));
    await finished;
    expect(jobs.start(7, () => new Promise<TlsProvisioningOutcome>(() => undefined))).toEqual({ jobId: 'job-2', joined: false });
    expect(jobs.snapshot().jobs).toHaveLength(1);
  });

  it('turns a run that throws into a failure with plain copy and logs the cause', async () => {
    const { jobs } = makeJobs();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const finished = nextSnapshot(jobs, (s) => s.jobs[0]?.state === 'finished');
      jobs.start(7, () => Promise.reject(new Error('pool exhausted')));
      expect((await finished).jobs[0].outcome).toEqual({ ok: false, code: null, message: UNEXPECTED_TLS_FAILURE_MESSAGE });
      expect(errorSpy.mock.calls[0]?.[0]).toBe('[hosts] TLS provisioning for host 7 failed unexpectedly:');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('keeps a finished job for the retention window, then drops it', async () => {
    const { jobs, advance } = makeJobs();
    const finished = nextSnapshot(jobs, (s) => s.jobs[0]?.state === 'finished');
    jobs.start(7, () => Promise.resolve(OK));
    await finished;

    advance(FINISHED_JOB_RETENTION_MS);
    expect(jobs.snapshot().jobs).toHaveLength(1);
    advance(1);
    expect(jobs.snapshot().jobs).toEqual([]);
  });

  it('never drops a running job, however long it runs', () => {
    const { jobs, advance } = makeJobs();
    jobs.start(7, () => new Promise<TlsProvisioningOutcome>(() => undefined));
    advance(FINISHED_JOB_RETENTION_MS * 10);
    expect(jobs.snapshot().jobs.map((j) => j.state)).toEqual(['running']);
  });

  it('keeps publishing to other subscribers when one throws', () => {
    const { jobs } = makeJobs();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      let calls = 0;
      jobs.subscribe(() => {
        if (calls++ > 0) throw new Error('subscriber broke');
      });
      const seen: TlsProvisioningSnapshot[] = [];
      jobs.subscribe((s) => seen.push(s));
      jobs.start(7, () => new Promise<TlsProvisioningOutcome>(() => undefined));
      expect(seen.at(-1)?.jobs[0]?.state).toBe('running');
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('shares one instance across separately bundled copies of the module', async () => {
    const first = await import('../tls-provisioning-jobs');
    const secondCopy = '../tls-provisioning-jobs?second-bundle';
    const second = (await import(secondCopy)) as typeof first;
    expect(second.TlsProvisioningJobs).not.toBe(first.TlsProvisioningJobs);
    expect(second.tlsProvisioningJobs).toBe(first.tlsProvisioningJobs);
  });

  it('produces snapshots the tls-provisioning channel schema accepts', async () => {
    const { jobs } = makeJobs();
    const finished = nextSnapshot(jobs, (s) => s.jobs.every((j) => j.state === 'finished') && s.jobs.length === 2);
    jobs.start(7, () => Promise.resolve(OK));
    jobs.start(8, () => Promise.resolve({ ok: false, code: 'poll_timeout', message: 'timed out' }));
    const snapshot = await finished;
    expect(zTlsProvisioningSnapshotWire.parse(snapshot)).toEqual(snapshot);
  });
});

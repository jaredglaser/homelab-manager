import type { TlsFailureCode } from '@homelab-manager/agent/types';

export type TlsProvisioningOutcome =
  | { ok: true; agentUrl: string; enrolledOverPlainHttp: boolean; fingerprint: string }
  | { ok: false; code: TlsFailureCode | null; message: string };

export interface TlsProvisioningJob {
  jobId: string;
  hostId: number;
  state: 'running' | 'finished';
  startedAt: string;
  finishedAt: string | null;
  outcome: TlsProvisioningOutcome | null;
}

export interface TlsProvisioningSnapshot {
  jobs: TlsProvisioningJob[];
}

type SnapshotCallback = (snapshot: TlsProvisioningSnapshot) => void;

/** Long enough for a page that reloaded or reconnected mid-run to still read the outcome. */
export const FINISHED_JOB_RETENTION_MS = 10 * 60 * 1000;

export const UNEXPECTED_TLS_FAILURE_MESSAGE =
  'Verification stopped on an unexpected error in the dashboard. The dashboard log has the details. Try again, and report it if it fails the same way.';

export interface TlsProvisioningJobsDeps {
  now?: () => number;
  newJobId?: () => string;
}

// A run takes about 16s and Bun closes a request idle for 10s, so it cannot live in the request that starts it.
// State is per process: a restart drops running jobs, and the host stores nothing until the HTTPS probe passes.
export class TlsProvisioningJobs {
  private readonly jobs = new Map<number, TlsProvisioningJob>();
  private readonly subscribers = new Set<SnapshotCallback>();
  private readonly now: () => number;
  private readonly newJobId: () => string;

  constructor(deps: TlsProvisioningJobsDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.newJobId = deps.newJobId ?? (() => crypto.randomUUID());
  }

  /** A second start for a host whose job is still running joins that job instead of racing it. */
  start(hostId: number, run: () => Promise<TlsProvisioningOutcome>): { jobId: string; joined: boolean } {
    const current = this.jobs.get(hostId);
    if (current?.state === 'running') return { jobId: current.jobId, joined: true };

    const job: TlsProvisioningJob = {
      jobId: this.newJobId(),
      hostId,
      state: 'running',
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: null,
      outcome: null,
    };
    this.jobs.set(hostId, job);
    this.publish();
    void this.settle(job, run);
    return { jobId: job.jobId, joined: false };
  }

  snapshot(): TlsProvisioningSnapshot {
    const cutoff = this.now() - FINISHED_JOB_RETENTION_MS;
    for (const [hostId, job] of this.jobs) {
      if (job.finishedAt !== null && Date.parse(job.finishedAt) < cutoff) this.jobs.delete(hostId);
    }
    return { jobs: [...this.jobs.values()].sort((a, b) => a.hostId - b.hostId) };
  }

  subscribe(callback: SnapshotCallback): () => void {
    this.subscribers.add(callback);
    callback(this.snapshot());
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private async settle(job: TlsProvisioningJob, run: () => Promise<TlsProvisioningOutcome>): Promise<void> {
    let outcome: TlsProvisioningOutcome;
    try {
      outcome = await run();
    } catch (err) {
      console.error(`[hosts] TLS provisioning for host ${job.hostId} failed unexpectedly:`, err);
      outcome = { ok: false, code: null, message: UNEXPECTED_TLS_FAILURE_MESSAGE };
    }
    this.jobs.set(job.hostId, { ...job, state: 'finished', finishedAt: new Date(this.now()).toISOString(), outcome });
    this.publish();
  }

  private publish(): void {
    const snapshot = this.snapshot();
    for (const callback of this.subscribers) {
      try {
        callback(snapshot);
      } catch (err) {
        console.error('[hosts] TLS provisioning subscriber failed:', err);
      }
    }
  }
}

const SHARED_INSTANCE_KEY = Symbol.for('homelab-manager.tls-provisioning-jobs');

// The server-function bundle and the /api/mux route bundle each load their own copy of this module.
const shared = globalThis as typeof globalThis & { [SHARED_INSTANCE_KEY]?: TlsProvisioningJobs };
export const tlsProvisioningJobs: TlsProvisioningJobs = (shared[SHARED_INSTANCE_KEY] ??= new TlsProvisioningJobs());

import { normalizeRunnerEvent, statusFromSummaries } from '@/lib/ansible/events';
import type { AnsibleBroadcastEvent } from '@/lib/ansible/run-broadcast-service';
import type { SidecarClient } from '@/lib/ansible/sidecar-client';
import type { AnsibleRunRepository } from '@/lib/database/repositories/ansible-run-repository';
import type { AnsibleHostSummary, AnsibleRun, AnsibleRunStatus } from '@/types/ansible';

export interface StartRunInput {
  playbook: string;
  hosts: string[];
  checkMode: boolean;
  requestedBy: string;
  extravars: Record<string, string>;
}

export interface AnsibleRunServiceDeps {
  repo: AnsibleRunRepository;
  client: SidecarClient;
  publish: (event: AnsibleBroadcastEvent) => void;
  newRunId?: () => string;
}

const TERMINAL_STATUSES: readonly AnsibleRunStatus[] = ['succeeded', 'failed', 'cancelled'];

export class AnsibleRunService {
  private readonly newRunId: () => string;

  constructor(private readonly deps: AnsibleRunServiceDeps) {
    this.newRunId = deps.newRunId ?? (() => crypto.randomUUID());
  }

  /** Returns once the sidecar accepts the run; the caller is not held open for the playbook's duration. */
  async start(input: StartRunInput): Promise<AnsibleRun> {
    const runId = this.newRunId();
    const record = await this.deps.repo.create({
      runId,
      playbook: input.playbook,
      hosts: input.hosts,
      checkMode: input.checkMode,
      requestedBy: input.requestedBy,
    });

    try {
      await this.deps.client.startRun({
        runId,
        playbook: input.playbook,
        hosts: input.hosts,
        check: input.checkMode,
        extravars: input.extravars,
      });
    } catch (err) {
      if (await this.deps.repo.finish(record.id, 'failed', [])) {
        this.deps.publish({ type: 'run_finished', runId, status: 'failed' });
      }
      throw err;
    }

    this.deps.publish({
      type: 'run_started',
      runId,
      playbook: input.playbook,
      hosts: input.hosts,
      checkMode: input.checkMode,
    });

    return record;
  }

  /** Never throws: a broken stream ends the run as failed rather than escaping to the caller. */
  async consume(record: AnsibleRun): Promise<AnsibleRunStatus> {
    let summaries: AnsibleHostSummary[] = [];
    let status: AnsibleRunStatus = 'running';

    try {
      for await (const raw of this.deps.client.streamEvents(record.runId)) {
        const event = normalizeRunnerEvent(raw);
        if (!event) continue;

        if (event.kind === 'stats') summaries = event.summaries;
        if (event.kind === 'status') status = event.status;

        await this.deps.repo.appendEvent(record.id, event);
        this.deps.publish({ type: 'run_event', runId: record.runId, event });
      }
    } catch (err) {
      console.error(`[Ansible] Event stream for run ${record.runId} ended in error:`, err);
      status = 'failed';
    }

    const finalStatus = TERMINAL_STATUSES.includes(status) ? status : statusFromSummaries(summaries);
    if (await this.deps.repo.finish(record.id, finalStatus, summaries)) {
      this.deps.publish({ type: 'run_finished', runId: record.runId, status: finalStatus });
    }
    return finalStatus;
  }

  async cancel(runId: string): Promise<void> {
    await this.deps.client.cancelRun(runId);
  }
}

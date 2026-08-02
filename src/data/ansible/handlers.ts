import type { AnsibleRunService, StartRunInput } from '@/lib/ansible/run-service';
import type { AnsibleRunRepository } from '@/lib/database/repositories/ansible-run-repository';
import type { AnsibleRun } from '@/types/ansible';

/**
 * Reserved `stack_secrets.stack_name` holding secrets that belong to a playbook rather
 * than a stack. Every variable in this scope is passed to the run as an extravar of the
 * same name, so a value stored as `hlm_baseline_secret` is the playbook var of that name.
 */
export const ANSIBLE_SECRET_SCOPE = '__ansible__';

export interface AnsibleHandlerDeps {
  service: AnsibleRunService;
  repo: AnsibleRunRepository;
  loadSecrets: () => Promise<Record<string, string>>;
  /** Injected so tests can await the drain; production fires it and returns. */
  onStarted?: (run: AnsibleRun) => void;
}

export interface StartRunRequest {
  playbook: string;
  hosts: string[];
  checkMode: boolean;
  requestedBy: string;
}

export async function handleStartRun(
  request: StartRunRequest,
  deps: AnsibleHandlerDeps,
): Promise<AnsibleRun> {
  const extravars = await deps.loadSecrets();
  const input: StartRunInput = { ...request, extravars };
  const run = await deps.service.start(input);

  const drain = deps.onStarted ?? ((started: AnsibleRun) => {
    void deps.service.consume(started).catch((err) => {
      console.error(`[Ansible] Draining run ${started.runId} failed:`, err);
    });
  });
  drain(run);

  return run;
}

export async function handleListRuns(
  limit: number,
  deps: Pick<AnsibleHandlerDeps, 'repo'>,
): Promise<AnsibleRun[]> {
  return deps.repo.findRecent(limit);
}

export async function handleCancelRun(
  runId: string,
  deps: Pick<AnsibleHandlerDeps, 'service'>,
): Promise<{ cancelled: boolean }> {
  await deps.service.cancel(runId);
  return { cancelled: true };
}

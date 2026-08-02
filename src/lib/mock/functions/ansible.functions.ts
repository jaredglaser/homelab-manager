/**
 * Mock Ansible server functions for demo / e2e mode. The feature ships disabled,
 * so the real functions throw AnsibleDisabledError before reaching a sidecar; these
 * mirror that by returning an empty history and refusing to start a run, which is
 * what the demo build would show a user who navigated to /automation.
 */
import type { AnsibleRun } from '@/types/ansible';

export async function listAnsibleRuns(): Promise<AnsibleRun[]> {
  return [];
}

export async function startAnsibleRun(): Promise<AnsibleRun> {
  throw new Error('Ansible execution is disabled in demo mode.');
}

export async function cancelAnsibleRun(): Promise<{ cancelled: boolean }> {
  return { cancelled: false };
}

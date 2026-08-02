export const ANSIBLE_RUN_STATUS_VALUES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export type AnsibleRunStatus = (typeof ANSIBLE_RUN_STATUS_VALUES)[number];

export const ANSIBLE_HOST_OUTCOME_VALUES = ['ok', 'changed', 'failed', 'unreachable'] as const;

export type AnsibleHostOutcome = (typeof ANSIBLE_HOST_OUTCOME_VALUES)[number];

/** Per-host tallies lifted from `playbook_on_stats`. `unreachable` is its own outcome, not a failure. */
export interface AnsibleHostSummary {
  host: string;
  ok: number;
  changed: number;
  failures: number;
  unreachable: number;
  skipped: number;
  outcome: AnsibleHostOutcome;
}

export type AnsibleRunEvent =
  | { kind: 'play_start'; counter: number; play: string }
  | { kind: 'task_start'; counter: number; task: string; action: string | null }
  | {
      kind: 'host_result';
      counter: number;
      host: string;
      task: string | null;
      outcome: AnsibleHostOutcome | 'skipped';
    }
  | { kind: 'stats'; counter: number; summaries: AnsibleHostSummary[] }
  | { kind: 'status'; counter: number; status: AnsibleRunStatus };

export interface AnsibleRun {
  id: number;
  runId: string;
  playbook: string;
  hosts: string[];
  checkMode: boolean;
  status: AnsibleRunStatus;
  requestedBy: string;
  summaries: AnsibleHostSummary[];
  createdAt: string;
  finishedAt: string | null;
}

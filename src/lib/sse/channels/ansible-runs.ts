import { z } from 'zod';
import { defineSseChannel } from '@/lib/sse/define-sse-channel';
import { ANSIBLE_RUN_STATUS_VALUES, ANSIBLE_HOST_OUTCOME_VALUES } from '@/types/ansible';
import type { AnsibleBroadcastEvent } from '@/lib/ansible/run-broadcast-service';

const zHostSummary = z.object({
  host: z.string(),
  ok: z.number(),
  changed: z.number(),
  failures: z.number(),
  unreachable: z.number(),
  skipped: z.number(),
  outcome: z.enum(ANSIBLE_HOST_OUTCOME_VALUES),
});

const zRunEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('play_start'), counter: z.number(), play: z.string() }),
  z.object({
    kind: z.literal('task_start'),
    counter: z.number(),
    task: z.string(),
    action: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('host_result'),
    counter: z.number(),
    host: z.string(),
    task: z.string().nullable(),
    outcome: z.enum([...ANSIBLE_HOST_OUTCOME_VALUES, 'skipped']),
  }),
  z.object({ kind: z.literal('stats'), counter: z.number(), summaries: z.array(zHostSummary) }),
  z.object({
    kind: z.literal('status'),
    counter: z.number(),
    status: z.enum(ANSIBLE_RUN_STATUS_VALUES),
  }),
]);

const zAnsibleRunMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run_started'),
    runId: z.string(),
    playbook: z.string(),
    hosts: z.array(z.string()),
    checkMode: z.boolean(),
  }),
  z.object({ type: z.literal('run_event'), runId: z.string(), event: zRunEvent }),
  z.object({
    type: z.literal('run_finished'),
    runId: z.string(),
    status: z.enum(ANSIBLE_RUN_STATUS_VALUES),
  }),
]);

export type AnsibleRunSSEMessage = z.infer<typeof zAnsibleRunMessage>;

export const ansibleRunsChannel = defineSseChannel({
  url: '/api/ansible-runs',
  errorEvent: 'ansible_runs_error',
  schema: zAnsibleRunMessage,
});

export function serializeAnsibleRunEvent(event: AnsibleBroadcastEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

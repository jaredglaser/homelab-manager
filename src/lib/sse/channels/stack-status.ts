import { z } from 'zod';
import { defineSseChannel } from '@/lib/sse/define-sse-channel';
import type { StackStatusEntry } from '@/types/stacks';
import type { DeployAction, DeployStatus, DeployTrigger } from '@/lib/deploy/types';
import type { DeployChangeOutcome } from '@/lib/database/repositories/deploy-repository';
import type { StackBroadcastEvent } from '@/lib/stacks/stack-status-broadcast-service';

/** Discriminated union for stack-status SSE messages (the wire shape has no Date fields, so `revive` is the identity). */
export type StackSSEMessage =
  | StackStatusEntry[]
  | { type: 'deploy_changed'; stack: string; host: string; outcome?: DeployChangeOutcome };

const zStackContainer = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  image: z.string(),
  service: z.string().nullable(),
});

const zStackStatusEntry = z.object({
  stack: z.string(),
  host: z.string(),
  containers: z.array(zStackContainer),
  updated_at: z.string(),
});

const DEPLOY_STATUS_VALUES = ['pending', 'in_progress', 'succeeded', 'failed', 'no_change'] as const satisfies readonly DeployStatus[];
const DEPLOY_ACTION_VALUES = ['deploy', 'teardown'] as const satisfies readonly DeployAction[];
const DEPLOY_TRIGGER_VALUES = ['git_push', 'ui', 'manual_rollback'] as const satisfies readonly DeployTrigger[];

const zDeployStatus = z.enum(DEPLOY_STATUS_VALUES);
const zDeployAction = z.enum(DEPLOY_ACTION_VALUES);
const zDeployTrigger = z.enum(DEPLOY_TRIGGER_VALUES);

const zDeployChangeOutcome = z.object({
  deployId: z.number(),
  status: zDeployStatus,
  action: zDeployAction,
  trigger: zDeployTrigger,
  message: z.string().optional(),
});

const zStackStatusWireMessage = z.union([
  z.array(zStackStatusEntry),
  z.object({
    type: z.literal('deploy_changed'),
    stack: z.string(),
    host: z.string(),
    outcome: zDeployChangeOutcome.optional(),
  }),
]);

export const stackStatusChannel = defineSseChannel({
  url: '/api/stack-status',
  errorEvent: 'stack_status_error',
  schema: zStackStatusWireMessage,
  revive: (message): StackSSEMessage => message,
});

/** Omits `outcome` entirely rather than sending it as null/undefined when absent. */
export function serializeStackStatusEvent(event: StackBroadcastEvent): string {
  if (event.type === 'deploy_changed') {
    const payload = {
      type: 'deploy_changed',
      stack: event.stack,
      host: event.host,
      ...(event.outcome !== undefined ? { outcome: event.outcome } : {}),
    };
    return `data: ${JSON.stringify(payload)}\n\n`;
  }
  return `data: ${JSON.stringify(event.entries)}\n\n`;
}

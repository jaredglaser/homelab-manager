import { z } from 'zod';
import { defineSseChannel } from '@/lib/sse/define-sse-channel';
import type { StackStatusEntry } from '@/types/stacks';
import type { DeployAction, DeployStatus, DeployTrigger } from '@/lib/deploy/types';

/** Discriminated union for stack-status SSE messages (the wire shape has no Date fields, so `revive` is the identity). */
export type StackSSEMessage =
  | StackStatusEntry[]
  | {
      type: 'deploy_changed';
      stack: string;
      host: string;
      deployId?: number;
      status?: DeployStatus;
      action?: DeployAction;
      trigger?: DeployTrigger;
      message?: string;
    };

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

const zDeployStatus = z.enum(['pending', 'in_progress', 'succeeded', 'failed', 'no_change']);
const zDeployAction = z.enum(['deploy', 'teardown']);
const zDeployTrigger = z.enum(['git_push', 'ui', 'manual_rollback']);

const zStackStatusWireMessage = z.union([
  z.array(zStackStatusEntry),
  z.object({
    type: z.literal('deploy_changed'),
    stack: z.string(),
    host: z.string(),
    deployId: z.number().optional(),
    status: zDeployStatus.optional(),
    action: zDeployAction.optional(),
    trigger: zDeployTrigger.optional(),
    message: z.string().optional(),
  }),
]);

export const stackStatusChannel = defineSseChannel({
  url: '/api/stack-status',
  errorEvent: 'stack_status_error',
  schema: zStackStatusWireMessage,
  revive: (message): StackSSEMessage => message,
});

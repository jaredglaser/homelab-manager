import { z } from 'zod';
import { defineSseChannel } from '@/lib/sse/define-sse-channel';
import type { StackStatusEntry } from '@/types/stacks';
import { zDeployChangeOutcome, type DeployChangeOutcome } from '@/lib/deploy/types';
import type { StackBroadcastEvent } from '@/lib/stacks/stack-status-broadcast-service';

/** Discriminated union for stack-status SSE messages (the wire shape has no Date fields, so `revive` is the identity). */
export type StackSSEMessage =
  | StackStatusEntry[]
  | { type: 'deploy_changed'; stack: string; host: string; outcome?: DeployChangeOutcome };

/** Duplicated from docker-inventory.ts's zContainerPortWeb to keep the schemas co-located per channel. */
const zStackContainerPort = z.object({
  containerPort: z.number(),
  protocol: z.string(),
  hostIp: z.string().nullable(),
  hostPort: z.number().nullable(),
});

/** Duplicated from docker-inventory.ts's zContainerMountWeb to keep the schemas co-located per channel. */
const zStackContainerMount = z.object({
  type: z.string(),
  source: z.string(),
  destination: z.string(),
  rw: z.boolean(),
});

const zStackContainer = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  image: z.string(),
  service: z.string().nullable(),
  ports: z.array(zStackContainerPort).default([]),
  mounts: z.array(zStackContainerMount).default([]),
});

const zStackStatusEntry = z.object({
  stack: z.string(),
  host: z.string(),
  containers: z.array(zStackContainer),
  updated_at: z.string(),
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

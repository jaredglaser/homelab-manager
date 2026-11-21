import { z } from 'zod';
import type { StackStatusEntry } from '@/types/stacks';
import { zDeployChangeOutcome, type DeployChangeOutcome } from '@/lib/deploy/types';
import type { StackBroadcastEvent } from '@/lib/stacks/stack-status-broadcast-service';
import { STACK_STATUS_TOPIC } from '@/lib/mux/protocol';
import type { MuxChannel } from '@/lib/mux/use-mux-channel';

export type StackStatusWireMessage =
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

export const stackStatusChannel: MuxChannel<typeof zStackStatusWireMessage> = {
  topic: STACK_STATUS_TOPIC,
  schema: zStackStatusWireMessage,
};

/** Omits `outcome` entirely rather than sending it as null/undefined when absent. */
export function toStackStatusWireMessage(event: StackBroadcastEvent): StackStatusWireMessage {
  if (event.type === 'deploy_changed') {
    return {
      type: 'deploy_changed',
      stack: event.stack,
      host: event.host,
      ...(event.outcome !== undefined ? { outcome: event.outcome } : {}),
    };
  }
  return event.entries;
}

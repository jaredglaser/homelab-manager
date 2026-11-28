import { z } from 'zod';
import type { AgentInventoryEntry } from '@/lib/hosts/agent-inventory';
import { AGENT_INVENTORY_STATUSES, zAgentUpdateStatus } from '@/lib/hosts/agent-inventory';
import { HOST_PROBE_FAILURE_CODES } from '@/lib/errors/host-failure-copy';
import { AGENT_INVENTORY_TOPIC } from '@/lib/mux/protocol';
import type { MuxChannel } from '@/lib/mux/use-mux-channel';

const zHostCapabilitiesWire = z.object({
  docker: z.boolean().optional(),
  zfs: z.boolean().optional(),
});

const zAgentInventoryFailureWire = z.object({
  code: z.enum(HOST_PROBE_FAILURE_CODES),
  message: z.string(),
});

const zAgentInventoryEntryWire = z.object({
  id: z.number(),
  name: z.string(),
  agentUrl: z.string(),
  capabilities: zHostCapabilitiesWire,
  status: z.enum(AGENT_INVENTORY_STATUSES),
  version: z.string().nullable(),
  agentImage: z.string().nullable(),
  agentImageTag: z.string().nullable(),
  agentImageDigest: z.string().nullable(),
  agentOutOfDate: z.boolean(),
  failure: zAgentInventoryFailureWire.nullable(),
  update: zAgentUpdateStatus.nullable(),
  checkedAt: z.string(),
});

export const zAgentInventorySnapshotWire = z.object({
  entries: z.array(zAgentInventoryEntryWire),
  sweptAt: z.string().nullable(),
});

export type AgentInventoryMessage = {
  entries: AgentInventoryEntry[];
  sweptAt: string | null;
};

export const agentInventoryChannel: MuxChannel<typeof zAgentInventorySnapshotWire> = {
  topic: AGENT_INVENTORY_TOPIC,
  schema: zAgentInventorySnapshotWire,
};

export type { AgentInventoryEntry };

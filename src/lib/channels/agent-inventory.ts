import { z } from 'zod';
import type { AgentInventoryEntry } from '@/lib/hosts/agent-inventory';
import { AGENT_INVENTORY_STATUSES } from '@/lib/hosts/agent-inventory';
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

// Both enums read their members from the runtime lists the types are derived from, so a status or
// code the server can send is one the client accepts; a narrower schema would drop the whole snapshot.
const zAgentInventoryEntryWire = z.object({
  id: z.number(),
  name: z.string(),
  agentUrl: z.string(),
  capabilities: zHostCapabilitiesWire,
  status: z.enum(AGENT_INVENTORY_STATUSES),
  version: z.string().nullable(),
  versionSource: z.enum(['live', 'stored', 'unknown']),
  agentImage: z.string().nullable(),
  agentImageTag: z.string().nullable(),
  agentImageDigest: z.string().nullable(),
  agentOutOfDate: z.boolean(),
  failure: zAgentInventoryFailureWire.nullable(),
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

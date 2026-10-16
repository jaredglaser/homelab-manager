import { z } from 'zod';
import type { AgentInventoryEntry } from '@/lib/hosts/agent-inventory';
import { AGENT_INVENTORY_TOPIC } from '@/lib/mux/protocol';
import type { MuxChannel } from '@/lib/mux/use-mux-channel';

const zHostCapabilitiesWire = z.object({
  docker: z.boolean().optional(),
  zfs: z.boolean().optional(),
});

const zAgentInventoryEntryWire = z.object({
  id: z.number(),
  name: z.string(),
  agentUrl: z.string(),
  capabilities: zHostCapabilitiesWire,
  status: z.enum(['online', 'offline', 'unreachable', 'unknown']),
  version: z.string().nullable(),
  versionSource: z.enum(['live', 'stored', 'unknown']),
  agentImage: z.string().nullable(),
  agentImageTag: z.string().nullable(),
  agentUpdaterImageDigest: z.string().nullable(),
  agentUpdaterImageTag: z.string().nullable(),
  updaterOutOfDate: z.boolean(),
  lastError: z.string().nullable(),
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

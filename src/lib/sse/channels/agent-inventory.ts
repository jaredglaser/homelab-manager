import { z } from 'zod';
import { defineSseChannel } from '@/lib/sse/define-sse-channel';
import type { AgentInventoryEntry } from '@/lib/hosts/agent-inventory';

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
  autoUpdate: z.boolean(),
  lastError: z.string().nullable(),
  checkedAt: z.string(),
});

export const zAgentInventorySnapshotWire = z.object({
  entries: z.array(zAgentInventoryEntryWire),
  sweptAt: z.string().nullable(),
});

export type AgentInventorySseMessage = {
  entries: AgentInventoryEntry[];
  sweptAt: string | null;
};

export const agentInventoryChannel = defineSseChannel({
  url: '/api/agent-inventory',
  errorEvent: 'agent_inventory_error',
  schema: zAgentInventorySnapshotWire,
  revive: (message): AgentInventorySseMessage => message,
});

export type { AgentInventoryEntry };

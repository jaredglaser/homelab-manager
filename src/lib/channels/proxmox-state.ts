import { z } from 'zod';
import { PROXMOX_STATE_TOPIC } from '@/lib/mux/protocol';
import type { MuxChannel } from '@/lib/mux/use-mux-channel';
import { PROXMOX_COLLECTOR_STATES } from '@/types/proxmox';

const zProxmoxCollectorStateWire = z.object({
  connectionId: z.string(),
  host: z.string(),
  port: z.number(),
  state: z.enum(PROXMOX_COLLECTOR_STATES),
  lastSuccessAt: z.number().nullable(),
  updatedAt: z.number(),
});

export const zProxmoxStateSnapshotWire = z.object({
  connections: z.array(zProxmoxCollectorStateWire),
});

export type ProxmoxStateMessage = z.infer<typeof zProxmoxStateSnapshotWire>;

export const proxmoxStateChannel: MuxChannel<typeof zProxmoxStateSnapshotWire> = {
  topic: PROXMOX_STATE_TOPIC,
  schema: zProxmoxStateSnapshotWire,
};

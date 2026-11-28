import { z } from 'zod';
import { ZFS_HEALTH_TOPIC } from '@/lib/mux/protocol';
import type { MuxChannel } from '@/lib/mux/use-mux-channel';
import { zZFSHostHealth } from '@/types/zfs';

export const zZfsHealthSnapshotWire = z.object({
  hosts: z.array(zZFSHostHealth),
});

export type ZfsHealthMessage = z.infer<typeof zZfsHealthSnapshotWire>;

export const zfsHealthChannel: MuxChannel<typeof zZfsHealthSnapshotWire> = {
  topic: ZFS_HEALTH_TOPIC,
  schema: zZfsHealthSnapshotWire,
};

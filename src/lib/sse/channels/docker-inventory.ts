import { z } from 'zod';
import { defineSseChannel } from '@/lib/sse/define-sse-channel';
import {
  zDockerInventorySnapshotContainer,
  zDockerInventoryUpdateContainer,
} from '@/types/docker-inventory';
import type { DockerInventoryBroadcastEvent } from '@/types/docker-inventory';

// Same fields as the canonical schemas, but Date fields re-typed as the ISO strings
// JSON.stringify actually produces; the canonical schemas type them z.date() because
// they also validate pre-serialization objects server-side.
const zSnapshotContainerWire = zDockerInventorySnapshotContainer.extend({
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  updatedAt: z.string(),
});
const zUpdateContainerWire = zDockerInventoryUpdateContainer.extend({
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  updatedAt: z.string(),
});

const zDockerInventoryWireEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('init'), containers: z.array(zSnapshotContainerWire) }),
  z.object({ type: z.literal('upsert'), container: zUpdateContainerWire }),
  z.object({ type: z.literal('destroy'), host: z.string(), containerId: z.string(), at: z.string() }),
]);

type WireInventoryDates = { startedAt: string | null; finishedAt: string | null; updatedAt: string };
type RevivedInventoryDates = { startedAt: Date | null; finishedAt: Date | null; updatedAt: Date };

function reviveContainerDates<T extends WireInventoryDates>(
  container: T,
): Omit<T, keyof WireInventoryDates> & RevivedInventoryDates {
  return {
    ...container,
    startedAt: container.startedAt ? new Date(container.startedAt) : null,
    finishedAt: container.finishedAt ? new Date(container.finishedAt) : null,
    updatedAt: new Date(container.updatedAt),
  };
}

export const dockerInventoryChannel = defineSseChannel({
  url: '/api/docker-inventory',
  errorEvent: 'inventory_error',
  schema: zDockerInventoryWireEvent,
  revive: (event): DockerInventoryBroadcastEvent => {
    if (event.type === 'init') {
      return { type: 'init', containers: event.containers.map(reviveContainerDates) };
    }
    if (event.type === 'upsert') {
      return { type: 'upsert', container: reviveContainerDates(event.container) };
    }
    return { type: 'destroy', host: event.host, containerId: event.containerId, at: new Date(event.at) };
  },
});

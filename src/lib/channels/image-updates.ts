import { z } from 'zod';
import { IMAGE_UPDATES_TOPIC } from '@/lib/mux/protocol';
import type { MuxChannel } from '@/lib/mux/use-mux-channel';
import type { ImageUpdateChangedEvent } from '@/lib/stacks/image-update-broadcast-service';

const zImageUpdateChanged = z.object({
  type: z.literal('updates_changed'),
  stack: z.string(),
  host: z.string(),
  image: z.string(),
  update_available: z.boolean().nullable(),
  latest_matching_tag: z.string().nullable(),
  checked_at: z.string(),
});

export type ImageUpdateWireMessage = z.infer<typeof zImageUpdateChanged>;

export function toImageUpdateWireMessage(event: ImageUpdateChangedEvent, checkedAt = new Date().toISOString()): ImageUpdateWireMessage {
  return {
    type: 'updates_changed' as const,
    stack: event.stack,
    host: event.host,
    image: event.image,
    update_available: event.updateAvailable,
    latest_matching_tag: event.latestMatchingTag,
    checked_at: checkedAt,
  };
}

export const imageUpdatesChannel: MuxChannel<typeof zImageUpdateChanged, ImageUpdateWireMessage> = {
  topic: IMAGE_UPDATES_TOPIC,
  schema: zImageUpdateChanged,
};

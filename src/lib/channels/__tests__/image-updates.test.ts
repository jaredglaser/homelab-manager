import { describe, expect, it } from 'bun:test';
import { toImageUpdateWireMessage } from '../image-updates';
import { imageUpdatesChannel } from '../image-updates';
import type { ImageUpdateChangedEvent } from '@/lib/stacks/image-update-broadcast-service';

const event: ImageUpdateChangedEvent = {
  stack: 'web',
  host: 'host1',
  image: 'redis:7',
  updateAvailable: true,
  latestMatchingTag: '7.4.2',
};

describe('toImageUpdateWireMessage', () => {
  it('maps the event to the snake_case wire shape with a checked_at stamp', () => {
    const wire = toImageUpdateWireMessage(event, '2026-01-03T00:00:00.000Z');
    expect(wire).toEqual({
      type: 'updates_changed',
      stack: 'web',
      host: 'host1',
      image: 'redis:7',
      update_available: true,
      latest_matching_tag: '7.4.2',
      checked_at: '2026-01-03T00:00:00.000Z',
    });
  });

  it('stamps checked_at with the current time by default', () => {
    const wire = toImageUpdateWireMessage(event);
    expect(new Date(wire.checked_at).getTime()).toBeGreaterThan(0);
  });
});

describe('imageUpdatesChannel', () => {
  it('parses a valid frame and rejects a malformed one', () => {
    expect(imageUpdatesChannel.schema.safeParse(toImageUpdateWireMessage(event)).success).toBe(true);
    expect(imageUpdatesChannel.schema.safeParse({ type: 'wrong' }).success).toBe(false);
  });
});

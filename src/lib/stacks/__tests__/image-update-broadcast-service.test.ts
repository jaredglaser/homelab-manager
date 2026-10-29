import { describe, expect, it } from 'bun:test';
import { ImageUpdateBroadcastService } from '../image-update-broadcast-service';

const event = {
  stack: 'web',
  host: 'host1',
  image: 'redis:7',
  updateAvailable: true,
  latestMatchingTag: '7.4.2',
};

describe('ImageUpdateBroadcastService', () => {
  it('delivers events to every subscriber and stops after unsubscribe', () => {
    const service = new ImageUpdateBroadcastService();
    const first: unknown[] = [];
    const second: unknown[] = [];
    const unsubscribeFirst = service.subscribe((e) => first.push(e));
    service.subscribe((e) => second.push(e));

    service.publish([event]);
    unsubscribeFirst();
    service.publish([event]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
    expect(second[0]).toEqual(event);
  });

  it('publishes nothing without subscribers', () => {
    const service = new ImageUpdateBroadcastService();
    expect(() => service.publish([event])).not.toThrow();
  });
});

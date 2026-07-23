import { describe, it, expect } from 'bun:test';
import { settingsChannel } from '../settings';

describe('settingsChannel', () => {
  it('exposes the url and errorEvent used by the route and the client', () => {
    expect(settingsChannel.url).toBe('/api/settings');
    expect(settingsChannel.errorEvent).toBe('settings_error');
  });

  it('validates an init frame', () => {
    const result = settingsChannel.schema.safeParse({ type: 'init', settings: { a: '1', b: '2' } });
    expect(result.success).toBe(true);
  });

  it('validates a change frame', () => {
    const result = settingsChannel.schema.safeParse({ type: 'change', key: 'a', value: '2' });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown message type', () => {
    const result = settingsChannel.schema.safeParse({ type: 'unknown' });
    expect(result.success).toBe(false);
  });

  it('revive is the identity', () => {
    const message = { type: 'init' as const, settings: { a: '1' } };
    expect(settingsChannel.revive!(message)).toBe(message);
  });
});

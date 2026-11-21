import { describe, it, expect } from 'bun:test';
import { settingsChannel } from '../settings';

describe('settingsChannel', () => {
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
});

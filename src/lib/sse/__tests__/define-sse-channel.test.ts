import { describe, it, expect } from 'bun:test';
import { z } from 'zod';
import { defineSseChannel } from '../define-sse-channel';

describe('defineSseChannel', () => {
  it('returns the descriptor unchanged, preserving field identity', () => {
    const schema = z.object({ value: z.number() });
    const revive = (raw: { value: number }) => ({ doubled: raw.value * 2 });

    const descriptor = defineSseChannel({
      url: '/api/example',
      errorEvent: 'example_error',
      schema,
      revive,
    });

    expect(descriptor.url).toBe('/api/example');
    expect(descriptor.errorEvent).toBe('example_error');
    expect(descriptor.schema).toBe(schema);
    expect(descriptor.revive).toBe(revive);
  });
});

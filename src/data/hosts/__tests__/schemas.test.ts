import { describe, it, expect } from 'bun:test';
import { removeHostSchema, checkHostHealthSchema, createPendingHostSchema, updateHostSchema, rotateHostTlsSchema } from '../schemas';

describe('removeHostSchema', () => {
  it('accepts positive integer', () => {
    expect(removeHostSchema.parse({ hostId: 1 }).hostId).toBe(1);
  });

  it('rejects zero, negative, non-integer', () => {
    expect(() => removeHostSchema.parse({ hostId: 0 })).toThrow();
    expect(() => removeHostSchema.parse({ hostId: -1 })).toThrow();
    expect(() => removeHostSchema.parse({ hostId: 1.5 })).toThrow();
  });
});

describe('checkHostHealthSchema', () => {
  it('accepts positive integer', () => {
    expect(checkHostHealthSchema.parse({ hostId: 7 }).hostId).toBe(7);
  });

  it('rejects invalid values', () => {
    expect(() => checkHostHealthSchema.parse({ hostId: 0 })).toThrow();
    expect(() => checkHostHealthSchema.parse({ hostId: -1 })).toThrow();
  });
});

function firstMessage(result: { success: boolean; error?: { issues: { message: string }[] } }): string | undefined {
  return result.error?.issues[0]?.message;
}

describe('createPendingHostSchema', () => {
  it.each(['dev-box', 'NAS_01', 'x'.repeat(100)])('accepts the name %p', (name) => {
    expect(createPendingHostSchema.safeParse({ name }).success).toBe(true);
  });

  it.each([
    ['', 'Enter a name for this host.'],
    ['my host', 'Use only letters, numbers, hyphens and underscores. Spaces are not allowed.'],
    ['nas.local', 'Use only letters, numbers, hyphens and underscores. Spaces are not allowed.'],
    ['x'.repeat(101), 'Use 100 characters or fewer.'],
  ])('rejects the name %p in words a user can act on', (name, message) => {
    expect(firstMessage(createPendingHostSchema.safeParse({ name }))).toBe(message);
  });
});

describe('agent URL', () => {
  it.each(['nas.local', 'http://256.256.256.256:9090', ''])('rejects %p in words a user can act on', (agentUrl) => {
    const message = 'Enter the full agent URL, such as https://192.168.1.10:9090.';
    expect(firstMessage(updateHostSchema.safeParse({ hostId: 1, agentUrl }))).toBe(message);
    expect(firstMessage(rotateHostTlsSchema.safeParse({ hostId: 1, agentUrl }))).toBe(message);
  });

  it('accepts a full URL', () => {
    expect(updateHostSchema.safeParse({ hostId: 1, agentUrl: 'https://192.168.1.10:9090' }).success).toBe(true);
  });
});

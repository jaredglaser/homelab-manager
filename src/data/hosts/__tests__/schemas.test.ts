import { describe, it, expect } from 'bun:test';
import { removeHostSchema, checkHostHealthSchema } from '../schemas';

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

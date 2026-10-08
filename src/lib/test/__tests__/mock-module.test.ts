import { describe, expect, it } from 'bun:test';
import { createRequire } from 'node:module';
import { mockModule } from '@/lib/test/mock-module';

const req = createRequire(import.meta.url);
const realKeys = Object.keys(req('@/lib/constants/ui-timing'));

mockModule<typeof import('@/lib/constants/ui-timing')>('@/lib/constants/ui-timing', (real) => ({
  ...real,
  PULSE_DURATION_MS: 12345,
}));

describe('mockModule', () => {
  it('applies the factory override', () => {
    expect(req('@/lib/constants/ui-timing').PULSE_DURATION_MS).toBe(12345);
  });

  it('keeps every export of the real module', () => {
    const mocked = req('@/lib/constants/ui-timing') as Record<string, unknown>;
    for (const key of realKeys) {
      expect(key in mocked).toBe(true);
    }
  });

  it('leaves unoverridden exports at real values', () => {
    expect(req('@/lib/constants/ui-timing').SELECTION_FEEDBACK_MS).toBe(150);
  });
});

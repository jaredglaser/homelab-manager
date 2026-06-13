import { describe, it, expect } from 'bun:test';
import { cn } from '@/lib/utils/cn';

describe('cn', () => {
  it('joins class names and drops falsy values', () => {
    expect(cn('a', false, undefined, 'b', null)).toBe('a b');
  });

  it('resolves Tailwind conflicts in favor of the last class', () => {
    expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4');
  });

  it('handles conditional object and array syntax', () => {
    expect(cn(['a', { b: true, c: false }])).toBe('a b');
  });
});

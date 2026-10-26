import { describe, expect, test } from 'bun:test';
import { BoundedCache } from '../bounded-cache';

describe('BoundedCache', () => {
  test('get returns a stored value within its ttl', () => {
    const cache = new BoundedCache<string>(2);
    cache.set('a', 'va', 60_000);
    expect(cache.get('a')).toBe('va');
  });

  test('an expired entry reads as absent', () => {
    const cache = new BoundedCache<string>(2);
    cache.set('a', 'va', -1);
    expect(cache.get('a')).toBeUndefined();
  });

  test('overflow evicts the oldest entry', () => {
    const cache = new BoundedCache<string>(2);
    cache.set('a', 'va', 60_000);
    cache.set('b', 'vb', 60_000);
    cache.set('c', 'vc', 60_000);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('vb');
    expect(cache.get('c')).toBe('vc');
  });

  test('overflow evicts expired entries before the oldest live one', () => {
    const cache = new BoundedCache<string>(2);
    cache.set('a', 'va', 60_000);
    cache.set('b', 'vb', -1);
    cache.set('c', 'vc', 60_000);
    expect(cache.get('a')).toBe('va');
    expect(cache.get('c')).toBe('vc');
  });

  test('re-setting a key counts as the newest entry', () => {
    const cache = new BoundedCache<string>(2);
    cache.set('a', 'va', 60_000);
    cache.set('b', 'vb', 60_000);
    cache.set('a', 'va2', 60_000);
    cache.set('c', 'vc', 60_000);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('va2');
  });
});
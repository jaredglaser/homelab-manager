import { describe, it, expect } from 'bun:test';
import { isSafeHttpUrl } from '@/lib/url-safety';

describe('isSafeHttpUrl', () => {
  it('allows http and https URLs', () => {
    expect(isSafeHttpUrl('https://example.com/a')).toBe(true);
    expect(isSafeHttpUrl('http://example.com')).toBe(true);
  });

  it('rejects other schemes', () => {
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('data:text/html,x')).toBe(false);
  });

  it('rejects strings that are not parseable URLs', () => {
    expect(isSafeHttpUrl('https://[')).toBe(false);
    expect(isSafeHttpUrl('docs/page')).toBe(false);
  });
});

// claudism-check:disable-file - assertions contain the exact banned strings.

import { describe, it, expect } from 'bun:test';
import { scanLinesForClaudisms } from '../claudism-check';

describe('scanLinesForClaudisms', () => {
  describe('dash patterns', () => {
    it('catches em dashes', () => {
      const [hit] = scanLinesForClaudisms(['hello—world']);
      expect(hit?.label).toBe('em dash');
    });

    it('catches en dashes', () => {
      const [hit] = scanLinesForClaudisms(['hello–world']);
      expect(hit?.label).toBe('en dash');
    });

    it('catches HTML entity forms', () => {
      expect(scanLinesForClaudisms(['&mdash;'])[0]?.label).toBe('&mdash;');
      expect(scanLinesForClaudisms(['&#8212;'])[0]?.label).toBe('&#8212;');
    });
  });

  describe('"canonical" vocab', () => {
    it('catches "canonical" as a whole word in prose', () => {
      const [hit] = scanLinesForClaudisms(['returns the canonical ManagedHost type']);
      expect(hit?.label).toBe('vocab: "canonical"');
    });

    it('does not match identifiers like `canonicalUrl`', () => {
      // Word boundary (\b) keeps camelCase identifiers from matching.
      expect(scanLinesForClaudisms(['const canonicalUrl = foo;'])).toEqual([]);
    });

    it('is case-insensitive', () => {
      expect(scanLinesForClaudisms(['Canonical ManagedHost'])[0]?.label).toBe('vocab: "canonical"');
    });
  });

  describe('clean input', () => {
    it('returns no hits for plain prose', () => {
      expect(scanLinesForClaudisms(['the cache was updated', 'we use the API'])).toEqual([]);
    });

    it('preserves line numbers via startLine offset', () => {
      const hits = scanLinesForClaudisms(['clean', 'canonical here'], 100);
      expect(hits).toHaveLength(1);
      expect(hits[0].line).toBe(101);
    });
  });
});

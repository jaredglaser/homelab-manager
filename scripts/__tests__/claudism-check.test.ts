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

  describe('vocabulary patterns', () => {
    it('catches "canonical" as a whole word', () => {
      const [hit] = scanLinesForClaudisms(['returns the canonical ManagedHost type']);
      expect(hit?.label).toBe('vocab: "canonical"');
    });

    it('does not match identifiers ending in banned words', () => {
      // Word boundary (\b) keeps `canonicalUrl`, `leverageRatio`, etc. from matching.
      expect(scanLinesForClaudisms(['const canonicalUrl = foo;'])).toEqual([]);
      expect(scanLinesForClaudisms(['leverageRatio = 2'])).toEqual([]);
    });

    it('allows "utilization" (legit monitoring noun) while catching "utilize"', () => {
      expect(scanLinesForClaudisms(['disk utilization is 90%'])).toEqual([]);
      expect(scanLinesForClaudisms(['utilize the new API'])[0]?.label).toBe('vocab: "utilize"');
      expect(scanLinesForClaudisms(['we utilized the cache'])[0]?.label).toBe('vocab: "utilize"');
    });

    it('is case-insensitive', () => {
      expect(scanLinesForClaudisms(['Canonical ManagedHost'])[0]?.label).toBe('vocab: "canonical"');
      expect(scanLinesForClaudisms(['DELVE into this'])[0]?.label).toBe('vocab: "delve"');
    });

    it('catches inflections of multi-form verbs', () => {
      expect(scanLinesForClaudisms(['leverages the feature'])[0]?.label).toBe('vocab: "leverage"');
      expect(scanLinesForClaudisms(['facilitating the flow'])[0]?.label).toBe('vocab: "facilitate"');
      expect(scanLinesForClaudisms(['delved deeper'])[0]?.label).toBe('vocab: "delve"');
    });

    it('catches performative qualifiers', () => {
      expect(scanLinesForClaudisms(['carefully crafted'])[0]?.label).toBe('vocab: "carefully"');
      expect(scanLinesForClaudisms(['thoroughly tested'])[0]?.label).toBe('vocab: "thoroughly"');
    });
  });

  describe('phrase patterns', () => {
    it('catches boilerplate sign-offs', () => {
      expect(scanLinesForClaudisms(['Hope this helps!'])[0]?.label).toBe('phrase: "hope this helps"');
      expect(scanLinesForClaudisms(['feel free to reach out if...'])[0]?.label).toBe('phrase: "feel free to reach out"');
    });

    it('catches "it\'s worth noting" with straight or smart quotes', () => {
      expect(scanLinesForClaudisms([`it's worth noting that`])[0]?.label).toBe('phrase: "it\'s worth noting"');
      expect(scanLinesForClaudisms([`it’s worth noting that`])[0]?.label).toBe('phrase: "it\'s worth noting"');
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

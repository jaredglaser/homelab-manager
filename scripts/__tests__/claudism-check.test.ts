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

    it('catches em dash entity forms (named, decimal, hex)', () => {
      expect(scanLinesForClaudisms(['&mdash;'])[0]?.label).toBe('&mdash;');
      expect(scanLinesForClaudisms(['&#8212;'])[0]?.label).toBe('&#8212;');
      expect(scanLinesForClaudisms(['&#x2014;'])[0]?.label).toBe('&#x2014;');
    });

    it('catches en dash entity forms (named, decimal, hex)', () => {
      expect(scanLinesForClaudisms(['&ndash;'])[0]?.label).toBe('&ndash;');
      expect(scanLinesForClaudisms(['&#8211;'])[0]?.label).toBe('&#8211;');
      expect(scanLinesForClaudisms(['&#x2013;'])[0]?.label).toBe('&#x2013;');
    });

    it('matches entity forms case-insensitively where the regex flag allows', () => {
      // Named and hex entity regexes use /gi; verify uppercase hex works.
      expect(scanLinesForClaudisms(['&#X2014;'])[0]?.label).toBe('&#x2014;');
      expect(scanLinesForClaudisms(['&MDASH;'])[0]?.label).toBe('&mdash;');
    });
  });

  describe('clean input', () => {
    it('returns no hits for plain prose', () => {
      expect(scanLinesForClaudisms(['the cache was updated', 'we use the API'])).toEqual([]);
    });

    it('does not match a plain hyphen used as a dash substitute', () => {
      // Only the real em/en characters and entities are banned, not ASCII '-'.
      expect(scanLinesForClaudisms(['build the app - then ship it'])).toEqual([]);
    });

    it('preserves line numbers via startLine offset', () => {
      const hits = scanLinesForClaudisms(['clean', 'bad—line'], 100);
      expect(hits).toHaveLength(1);
      expect(hits[0].line).toBe(101);
    });
  });
});

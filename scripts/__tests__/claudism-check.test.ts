// claudism-check:disable-file - assertions contain the exact banned strings.

import { describe, it, expect } from 'bun:test';
import { scanLinesForClaudisms } from '../claudism-check';

describe('scanLinesForClaudisms', () => {
  // Every form a dash can take, including uppercase entities, since the regexes
  // are built from codepoints and the entity matches rely on the /i flag.
  it.each([
    ['—', 'em dash'],
    ['–', 'en dash'],
    ['&mdash;', '&mdash;'],
    ['&MDASH;', '&mdash;'],
    ['&#8212;', '&#8212;'],
    ['&#x2014;', '&#x2014;'],
    ['&#X2014;', '&#x2014;'],
    ['&ndash;', '&ndash;'],
    ['&#8211;', '&#8211;'],
    ['&#x2013;', '&#x2013;'],
  ])('flags %p with label %p', (input, label) => {
    expect(scanLinesForClaudisms([`before ${input} after`])[0]?.label).toBe(label);
  });

  // ASCII hyphen and ordinary prose must not trip the scan.
  it.each(['the cache was updated', 'build the app - then ship it'])(
    'leaves clean line alone: %p',
    (line) => expect(scanLinesForClaudisms([line])).toEqual([]),
  );

  it('reports the 1-based line number via the startLine offset', () => {
    expect(scanLinesForClaudisms(['clean', 'bad—line'], 100)[0]?.line).toBe(101);
  });
});

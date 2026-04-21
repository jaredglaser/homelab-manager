// claudism-check:disable-file — this module defines the patterns, so it must
// legitimately contain every banned character. Respected by claudism-check-hook.ts.

/**
 * Banned dash-like characters and HTML entity encodings per CLAUDE.md rule 15.
 * Single source of truth shared by the Claude PostToolUse hook and the
 * git pre-commit hook so the two can't drift.
 */

export type ClaudismPattern = { label: string; regex: RegExp };

export const CLAUDISM_PATTERNS: ClaudismPattern[] = [
  { label: "em dash", regex: /—/g },
  { label: "en dash", regex: /–/g },
  { label: "&mdash;", regex: /&mdash;/gi },
  { label: "&ndash;", regex: /&ndash;/gi },
  { label: "&#8212;", regex: /&#8212;/g },
  { label: "&#8211;", regex: /&#8211;/g },
  { label: "&#x2014;", regex: /&#x2014;/gi },
  { label: "&#x2013;", regex: /&#x2013;/gi },
];

export type Hit = { line: number; label: string; text: string };

export function scanLinesForClaudisms(lines: string[], startLine = 1): Hit[] {
  const hits: Hit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    for (const { label, regex } of CLAUDISM_PATTERNS) {
      regex.lastIndex = 0;
      if (regex.test(text)) {
        hits.push({ line: startLine + i, label, text: text.trim().slice(0, 200) });
        break;
      }
    }
  }
  return hits;
}

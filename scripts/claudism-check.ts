/**
 * Shared claudism-check logic: banned dash patterns, file allowlist, and the
 * line scanner. Imported by the Claude PostToolUse hook
 * (.claude/scripts/claudism-check-hook.ts) and its unit tests.
 *
 * Only mechanical, zero-false-positive patterns live here: em/en dash
 * characters and their HTML entity encodings (named, decimal, hex). The rest of
 * CLAUDE.md rule 15 (vocabulary tells, sign-offs) stays model judgment.
 *
 * Patterns are built from the Unicode codepoints (U+2014 em, U+2013 en) so this
 * source never contains a literal banned token and needs no disable marker.
 */

import { basename, extname } from "node:path";

export type ClaudismPattern = { label: string; regex: RegExp };

/**
 * Build the four forms of a dash from its codepoint: the raw character plus the
 * named, decimal, and hex HTML entity encodings. Entity matches are
 * case-insensitive (e.g. &MDASH;, &#X2014;); the raw character match is not.
 */
function dashPatterns(human: string, name: string, code: number): ClaudismPattern[] {
  const char = String.fromCodePoint(code);
  const hex = code.toString(16);
  return [
    { label: human, regex: new RegExp(char, "g") },
    { label: `&${name};`, regex: new RegExp(`&${name};`, "gi") },
    { label: `&#${code};`, regex: new RegExp(`&#${code};`, "g") },
    { label: `&#x${hex};`, regex: new RegExp(`&#x${hex};`, "gi") },
  ];
}

export const CLAUDISM_PATTERNS: ClaudismPattern[] = [
  ...dashPatterns("em dash", "mdash", 0x2014),
  ...dashPatterns("en dash", "ndash", 0x2013),
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

/**
 * Extensions present in this repo that can contain prose (comments, JSDoc,
 * docs, user-facing strings). Other extensions skip safely. Add here if a new
 * text format lands; do not pre-emptively include languages this project
 * doesn't use.
 */
export const ALLOWED_EXTS = new Set([
  ".ts", ".tsx", ".js",  // source
  ".md",                 // docs
  ".sql",                // migrations (comments)
  ".json",               // config (descriptions, scripts)
  ".yml", ".yaml",       // compose, GitHub Actions
  ".toml",               // bunfig
  ".sh",                 // shell scripts
  ".css",                // App.css comments
  ".txt",                // plain text (NOTICE, etc.)
]);

/** Extensionless basenames that are still plain text source in this repo. */
export const ALLOWED_BASENAMES = new Set([
  "Dockerfile",
]);

/** Generated or lockfile basenames to skip even when the extension matches. */
export const SKIP_BASENAMES = new Set([
  "routeTree.gen.ts", "bun.lock",
]);

/** True if the path points to a file we should scan for claudisms. */
export function isScannablePath(relPath: string): boolean {
  const b = basename(relPath);
  if (SKIP_BASENAMES.has(b)) return false;
  if (ALLOWED_BASENAMES.has(b)) return true;
  return ALLOWED_EXTS.has(extname(b).toLowerCase());
}

export const DISABLE_MARKER = "claudism-check:disable-file";

// Pattern definitions and scanner shared by the Claude PostToolUse hook and its
// tests. Built from codepoints (U+2014 em, U+2013 en) so this file holds no
// literal banned token and needs no disable marker.

import { basename, extname } from "node:path";

export type ClaudismPattern = { label: string; regex: RegExp };

// Raw char plus its named/decimal/hex entity encodings. Entity forms match
// case-insensitively (&MDASH;, &#X2014;); the raw character does not.
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

// File types in this repo that can hold prose; everything else skips.
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

export const ALLOWED_BASENAMES = new Set([
  "Dockerfile",
]);

// Generated/lockfiles to skip even when the extension matches.
export const SKIP_BASENAMES = new Set([
  "routeTree.gen.ts", "bun.lock",
]);

export function isScannablePath(relPath: string): boolean {
  const b = basename(relPath);
  if (SKIP_BASENAMES.has(b)) return false;
  if (ALLOWED_BASENAMES.has(b)) return true;
  return ALLOWED_EXTS.has(extname(b).toLowerCase());
}

export const DISABLE_MARKER = "claudism-check:disable-file";

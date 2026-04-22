// claudism-check:disable-file — this module defines the patterns, so it must
// legitimately contain every banned character and word. Respected by the
// Claude PostToolUse hook and the Codex Stop hook via the file-header marker.

/**
 * Shared claudism-check logic: banned patterns, allowlist, and scan helper.
 * Single source of truth for the Claude PostToolUse hook and the Codex Stop
 * hook so they can't drift.
 *
 * Pattern categories (CLAUDE.md rule 15):
 *   1. Dash-like characters and HTML entity encodings (em/en dash variants).
 *   2. `canonical` - common LLM flourish in this codebase. Word-boundary
 *      anchored so `canonicalUrl` (identifier) does not match `canonical`
 *      (prose).
 */

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

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

  { label: 'vocab: "canonical"', regex: /\bcanonical\b/gi },
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

/** True if the file's first 4KB contain the opt-out marker. Errors read as no-marker. */
export function hasDisableMarker(filePath: string): boolean {
  try {
    return readFileSync(filePath, "utf8").slice(0, 4096).includes(DISABLE_MARKER);
  } catch {
    return false;
  }
}

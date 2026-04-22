// claudism-check:disable-file — this module defines the patterns, so it must
// legitimately contain every banned character and word. Respected by
// claudism-check-hook.ts and claudism-precommit.ts via the file-header marker.

/**
 * Shared claudism-check logic: banned patterns, allowlist, and scan helper.
 * Single source of truth for the Claude PostToolUse hook and the git pre-commit
 * hook so they can't drift.
 *
 * Two pattern categories (CLAUDE.md rule 15):
 *   1. Dash-like characters and HTML entity encodings (em/en dash variants).
 *   2. Vocabulary tells - LLM-speak words matched as whole words, case-
 *      insensitively. Word boundaries (\b) keep identifiers like `canonicalUrl`
 *      from matching, and alternation groups deliberately exclude legit
 *      technical forms: `utilize`/`utilized` match, but `utilization` (the
 *      ZFS/CPU percent-of-capacity term used across this codebase) does not.
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
  { label: 'vocab: "delve"', regex: /\bdelv(e|es|ed|ing)\b/gi },
  { label: 'vocab: "tapestry"', regex: /\btapestr(y|ies)\b/gi },
  { label: 'vocab: "intricate"', regex: /\bintricate(ly)?\b/gi },
  { label: 'vocab: "robust"', regex: /\brobust(ly|ness)?\b/gi },
  { label: 'vocab: "comprehensive"', regex: /\bcomprehensive(ly)?\b/gi },
  { label: 'vocab: "meticulous"', regex: /\bmeticulous(ly)?\b/gi },
  { label: 'vocab: "leverage"', regex: /\bleverag(e|es|ed|ing)\b/gi },
  { label: 'vocab: "utilize"', regex: /\butiliz(e|es|ed|ing)\b/gi },
  { label: 'vocab: "facilitate"', regex: /\bfacilitat(e|es|ed|ing|or|ion)\b/gi },
  { label: 'vocab: "essentially"', regex: /\bessentially\b/gi },
  { label: 'vocab: "fundamentally"', regex: /\bfundamentally\b/gi },
  { label: 'vocab: "carefully"', regex: /\bcarefully\b/gi },
  { label: 'vocab: "thoroughly"', regex: /\bthoroughly\b/gi },

  { label: 'phrase: "it\'s worth noting"', regex: /\bit['’]s worth noting\b/gi },
  { label: 'phrase: "it\'s important to note"', regex: /\bit['’]s important to note\b/gi },
  { label: 'phrase: "hope this helps"', regex: /\bhope this helps\b/gi },
  { label: 'phrase: "feel free to reach out"', regex: /\bfeel free to reach out\b/gi },
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

/** Extensions known to be source text. Unknown types skip safely. */
export const ALLOWED_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".md", ".mdx", ".txt",
  ".json", ".jsonc",
  ".yml", ".yaml", ".toml", ".hcl", ".properties",
  ".sql",
  ".sh", ".bash", ".zsh",
  ".html", ".css", ".scss",
  ".py", ".rb", ".go", ".rs", ".java",
]);

/** Extensionless / dot-prefixed basenames that are still plain text source. */
export const ALLOWED_BASENAMES = new Set([
  "Dockerfile", "Makefile", "README", "LICENSE", "CHANGELOG", "CODEOWNERS", "Caddyfile",
  ".gitignore", ".gitattributes", ".dockerignore", ".editorconfig",
  ".npmrc", ".nvmrc", ".node-version", ".bun-version",
  ".env", ".env.example",
]);

/** Generated files that happen to match an allowed extension. */
export const SKIP_BASENAMES = new Set([
  "routeTree.gen.ts", "package-lock.json", "bun.lock", "yarn.lock", "pnpm-lock.yaml",
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

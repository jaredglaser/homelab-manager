#!/usr/bin/env bun
/**
 * Codex Stop hook: surface claudism-check matches from this turn's edits.
 *
 * Codex has no per-edit hook (PostToolUse only fires for Bash), so the end-of-
 * turn Stop event is the earliest the model sees a file-content warning. This
 * script runs `git diff` against HEAD for unstaged changes, scans newly-added
 * lines for banned patterns (shared regex set in scripts/claudism-check.ts),
 * and emits a systemMessage so the model sees matches before the user does.
 *
 * Fails open: any error produces `{ "continue": true }` so a broken hook
 * can't stall Codex.
 *
 * Enable with `[features] codex_hooks = true` in `~/.codex/config.toml`.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DISABLE_MARKER,
  hasDisableMarker,
  isScannablePath,
  scanLinesForClaudisms,
} from "../../scripts/claudism-check";

type StopInput = { cwd?: string };

function emit(obj: Record<string, unknown>): never {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

let input: StopInput = {};
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  emit({ continue: true });
}

const cwd = input.cwd ?? process.cwd();

type FileHit = { file: string; line: number; label: string; text: string };
const hits: FileHit[] = [];

function scanFile(relPath: string, lines: string[], startLine = 1): void {
  if (!isScannablePath(relPath)) return;
  if (hasDisableMarker(join(cwd, relPath))) return;
  for (const h of scanLinesForClaudisms(lines, startLine)) {
    hits.push({ file: relPath, ...h });
  }
}

// 1. Tracked file changes: parse the unified diff and scan added lines.
// On a fresh repo with no HEAD (or any other diff failure), treat as no tracked
// changes and fall through to the untracked-files pass below rather than aborting.
const diff = spawnSync("git", ["diff", "HEAD", "--unified=0", "--no-color"], {
  cwd,
  encoding: "utf8",
});
const diffOutput = diff.status === 0 ? diff.stdout : "";

let currentFile = "";
let nextLine = 0;
let currentSkip = false;
for (const line of diffOutput.split("\n")) {
  if (line.startsWith("+++ ")) {
    const path = line.slice(4);
    currentFile = path === "/dev/null" || !path.startsWith("b/") ? "" : path.slice(2);
    currentSkip = !currentFile
      || !isScannablePath(currentFile)
      || hasDisableMarker(join(cwd, currentFile));
    nextLine = 0;
  } else if (line.startsWith("@@")) {
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    nextLine = m ? parseInt(m[1], 10) : 0;
  } else if (!currentSkip && currentFile && line.startsWith("+") && !line.startsWith("+++")) {
    const [hit] = scanLinesForClaudisms([line.slice(1)], nextLine);
    if (hit) hits.push({ file: currentFile, ...hit });
    nextLine++;
  }
}

// 2. Untracked files: diff shows nothing for these, so scan the whole file.
const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
  cwd,
  encoding: "utf8",
});
if (untracked.status === 0) {
  for (const rel of untracked.stdout.split("\n").filter(Boolean)) {
    try {
      const body = readFileSync(join(cwd, rel), "utf8");
      scanFile(rel, body.split(/\r?\n/));
    } catch {
      // unreadable / removed between ls-files and read - skip
    }
  }
}

if (hits.length === 0) emit({ continue: true });

const body = hits
  .slice(0, 50)
  .map((h) => `  ${h.file}:${h.line} [${h.label}] ${h.text}`)
  .join("\n");
const more = hits.length > 50 ? `\n  (${hits.length - 50} more)` : "";

emit({
  continue: true,
  systemMessage:
    `Claudism patterns detected in unstaged changes (CLAUDE.md rule 15). ` +
    `Fix before handing back to the user, or add '${DISABLE_MARKER}' to files that legitimately need the text.\n${body}${more}`,
});

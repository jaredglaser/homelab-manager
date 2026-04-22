#!/usr/bin/env bun
/**
 * Pre-commit claudism check.
 *
 * Scans only newly-added lines (`+` in the staged diff) so a developer editing
 * a file with pre-existing violations elsewhere isn't blocked. Exits 1 if any
 * added line contains a banned dash, entity, vocabulary tell, or phrase per
 * CLAUDE.md rule 15.
 *
 * Tool-agnostic: runs for Claude, Codex, Cursor, or plain `git commit`.
 * Install once per clone: `bun run hooks:install`.
 */

import { spawnSync } from "node:child_process";
import { hasDisableMarker, isScannablePath, scanLinesForClaudisms } from "./claudism-check";

const diff = spawnSync("git", ["diff", "--cached", "-U0", "--no-color"], { encoding: "utf8" });
if (diff.status !== 0) {
  console.error(`claudism-precommit: git diff failed (${diff.status}); skipping check`);
  process.exit(0);
}

type AddedLine = { line: number; text: string };
const perFile = new Map<string, AddedLine[]>();
let currentFile = "";
let nextLine = 0;

for (const line of diff.stdout.split("\n")) {
  if (line.startsWith("+++ ")) {
    const path = line.slice(4);
    currentFile = path === "/dev/null" || !path.startsWith("b/") ? "" : path.slice(2);
    if (currentFile && !isScannablePath(currentFile)) currentFile = "";
    nextLine = 0;
  } else if (line.startsWith("@@")) {
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    nextLine = m ? parseInt(m[1], 10) : 0;
  } else if (currentFile && line.startsWith("+") && !line.startsWith("+++")) {
    const added: AddedLine = { line: nextLine, text: line.slice(1) };
    const bucket = perFile.get(currentFile);
    if (bucket) bucket.push(added); else perFile.set(currentFile, [added]);
    nextLine++;
  }
}

let totalHits = 0;
for (const [file, added] of perFile) {
  if (hasDisableMarker(file)) continue;
  for (const a of added) {
    const [hit] = scanLinesForClaudisms([a.text], a.line);
    if (hit) {
      console.error(`${file}:${hit.line}: [${hit.label}] ${hit.text}`);
      totalHits++;
    }
  }
}

if (totalHits > 0) {
  console.error(`\n${totalHits} banned pattern(s) in staged lines. See CLAUDE.md rule 15.`);
  console.error(`Rephrase (use plain words, commas, parens, or colons) or add the`);
  console.error(`'claudism-check:disable-file' marker if the file legitimately needs the text.`);
  console.error(`To override (rare): git commit --no-verify`);
  process.exit(1);
}

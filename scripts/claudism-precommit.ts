#!/usr/bin/env bun
/**
 * Pre-commit claudism check.
 *
 * Scans only newly-added lines (`+` in the staged diff) so a developer editing
 * a file with pre-existing violations elsewhere isn't blocked. Exits 1 if any
 * added line contains a banned dash/entity per CLAUDE.md rule 15.
 *
 * Tool-agnostic: runs for Claude, Codex, Cursor, or plain `git commit`.
 * Install once per clone: `bun run hooks:install`.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { scanLinesForClaudisms } from "./claudism-patterns";

const ALLOWED_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".md", ".mdx", ".txt",
  ".json", ".jsonc",
  ".yml", ".yaml", ".toml", ".hcl", ".properties",
  ".sql",
  ".sh", ".bash", ".zsh",
  ".html", ".css", ".scss",
  ".py", ".rb", ".go", ".rs", ".java",
]);
const ALLOWED_BASENAMES = new Set([
  "Dockerfile", "Makefile", "README", "LICENSE", "CHANGELOG", "CODEOWNERS", "Caddyfile",
  ".gitignore", ".gitattributes", ".dockerignore", ".editorconfig",
  ".npmrc", ".nvmrc", ".node-version", ".bun-version",
  ".env", ".env.example",
]);
const SKIP_BASENAMES = new Set([
  "routeTree.gen.ts", "package-lock.json", "bun.lock", "yarn.lock", "pnpm-lock.yaml",
]);

function isAllowed(rel: string): boolean {
  const b = basename(rel);
  if (SKIP_BASENAMES.has(b)) return false;
  if (ALLOWED_BASENAMES.has(b)) return true;
  return ALLOWED_EXTS.has(extname(b).toLowerCase());
}

function hasDisableMarker(file: string): boolean {
  try {
    return readFileSync(file, "utf8").slice(0, 4096).includes("claudism-check:disable-file");
  } catch {
    return false;
  }
}

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
    if (currentFile && !isAllowed(currentFile)) currentFile = "";
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
  console.error(`\n${totalHits} banned character(s) in staged lines. See CLAUDE.md rule 15.`);
  console.error(`Use commas, parens, or colons instead. To override (rare): git commit --no-verify`);
  process.exit(1);
}

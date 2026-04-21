#!/usr/bin/env bun
/**
 * Claudism check hook.
 *
 * PostToolUse hook that greps the just-edited file for banned "claudism"
 * patterns (em dashes, en dashes, and their HTML entity encodings) per
 * CLAUDE.md rule 15. When matches are found, emits hookSpecificOutput with
 * additionalContext so the model sees them and can fix before moving on.
 *
 * Fails open (silent exit 0 on any error) so a broken check can't block edits.
 *
 * Set CLAUDE_CLAUDISM_HOOK_DEBUG=1 to log to $TMPDIR/claude-claudism-hook.log.
 */

import { readFileSync, existsSync, statSync, appendFileSync } from "node:fs";
import { basename as baseName, join, resolve as resolvePath, relative, extname, sep } from "node:path";
import { tmpdir } from "node:os";
import { scanLinesForClaudisms, type Hit } from "../../scripts/claudism-patterns";

type HookInput = {
  tool_input?: { file_path?: string; notebook_path?: string };
};

const DEBUG = !!process.env.CLAUDE_CLAUDISM_HOOK_DEBUG;
const LOG_PATH = join(tmpdir(), "claude-claudism-hook.log");
const log = (msg: string) => {
  if (!DEBUG) return;
  try { appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
};

function exitSilently(reason: string): never {
  log(`skip: ${reason}`);
  process.exit(0);
}

const projectDir = process.env.CLAUDE_PROJECT_DIR
  ? resolvePath(process.env.CLAUDE_PROJECT_DIR)
  : process.cwd();

let input: HookInput;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch (e) {
  exitSilently(`bad stdin: ${e}`);
}

const candidate = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
if (!candidate) exitSilently("no file_path in tool_input");

const filePath = resolvePath(candidate);
const rel = relative(projectDir, filePath);
if (rel.startsWith("..") || resolvePath(rel, projectDir) === filePath && rel === filePath) {
  // Path escapes the project dir; don't scan it.
  exitSilently(`outside project: ${filePath}`);
}


// Skip directories commonly containing generated / vendor output.
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", ".next", ".turbo", "coverage",
  ".cache", ".bun", "out",
]);
const relParts = rel.split(sep);
for (const part of relParts) {
  if (SKIP_DIRS.has(part)) exitSilently(`skipped dir segment: ${part}`);
}

// Allowlist approach: only scan file types we're confident are source text.
// Unknown types skip (safe default). Extend as needed.
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
// Extensionless / dot-prefixed files that are still plain text source.
const ALLOWED_BASENAMES = new Set([
  "Dockerfile", "Makefile", "README", "LICENSE", "CHANGELOG", "CODEOWNERS", "Caddyfile",
  ".gitignore", ".gitattributes", ".dockerignore", ".editorconfig",
  ".npmrc", ".nvmrc", ".node-version", ".bun-version",
  ".env", ".env.example",
]);
// Generated files that happen to match allowed extensions.
const SKIP_BASENAMES = new Set([
  "routeTree.gen.ts",
  "package-lock.json",
  "bun.lock",
  "yarn.lock",
  "pnpm-lock.yaml",
]);
const base = baseName(rel);
if (SKIP_BASENAMES.has(base)) exitSilently(`generated file: ${base}`);
const ext = extname(base).toLowerCase();
if (!ALLOWED_EXTS.has(ext) && !ALLOWED_BASENAMES.has(base)) {
  exitSilently(`not in allowlist: ${base}`);
}

if (!existsSync(filePath)) exitSilently("file does not exist post-edit");

let st;
try { st = statSync(filePath); } catch (e) { exitSilently(`stat failed: ${e}`); }
if (!st.isFile()) exitSilently("not a regular file");
// Cap at 2 MB; anything larger is almost certainly not a source file we should lint.
if (st.size > 2 * 1024 * 1024) exitSilently(`file too large: ${st.size}b`);

let contents: string;
try {
  contents = readFileSync(filePath, "utf8");
} catch (e) {
  exitSilently(`read failed: ${e}`);
}

const head = contents.slice(0, 4096);
// Crude binary sniff: reject files with NUL bytes in the first 4KB.
if (head.includes("\0")) exitSilently("binary sniff: contains NUL");
// Opt-out marker for files that legitimately contain the banned patterns
// (the patterns module itself, tests that assert the rule).
if (head.includes("claudism-check:disable-file")) exitSilently("opt-out marker");

const hits: Hit[] = scanLinesForClaudisms(contents.split(/\r?\n/));
if (hits.length === 0) exitSilently("clean");

const body = hits
  .map((h) => `  L${h.line} ${h.label}: ${h.text}`)
  .join("\n");

const output = {
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: `<claudism-check file="${rel}">\nBanned characters found (CLAUDE.md rule 15). Replace with commas, parens, or colons.\n${body}\n</claudism-check>`,
  },
};
process.stdout.write(JSON.stringify(output));
log(`emitted ${hits.length} claudism(s) in ${rel}`);

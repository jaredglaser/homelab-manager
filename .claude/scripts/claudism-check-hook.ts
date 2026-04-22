#!/usr/bin/env bun
/**
 * Claudism check hook.
 *
 * PostToolUse hook that greps the just-edited file for banned "claudism"
 * patterns (em/en dashes, HTML entity encodings, LLM vocabulary tells, and
 * stock phrases) per CLAUDE.md rule 15. When matches are found, emits
 * hookSpecificOutput with additionalContext so the model sees them and can
 * fix before moving on.
 *
 * Fails open (silent exit 0 on any error) so a broken check can't block edits.
 *
 * Set CLAUDE_CLAUDISM_HOOK_DEBUG=1 to log to $TMPDIR/claude-claudism-hook.log.
 */

import { readFileSync, existsSync, statSync, appendFileSync } from "node:fs";
import { join, resolve as resolvePath, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  DISABLE_MARKER,
  isScannablePath,
  scanLinesForClaudisms,
  type Hit,
} from "../../scripts/claudism-check";

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
// Hook-specific (the pre-commit path gets these pre-filtered by git).
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", ".next", ".turbo", "coverage",
  ".cache", ".bun", "out",
]);
for (const part of rel.split(sep)) {
  if (SKIP_DIRS.has(part)) exitSilently(`skipped dir segment: ${part}`);
}
if (!isScannablePath(rel)) exitSilently(`not scannable: ${rel}`);

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

const preview = contents.slice(0, 4096);
// Crude binary sniff: reject files with NUL bytes in the first 4KB.
if (preview.includes("\0")) exitSilently("binary sniff: contains NUL");
// Opt-out marker for files that legitimately contain the banned patterns
// (the patterns module itself, tests that assert the rule).
if (preview.includes(DISABLE_MARKER)) exitSilently("opt-out marker");

const hits: Hit[] = scanLinesForClaudisms(contents.split(/\r?\n/));
if (hits.length === 0) exitSilently("clean");

const body = hits
  .map((h) => `  L${h.line} ${h.label}: ${h.text}`)
  .join("\n");

const output = {
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: `<claudism-check file="${rel}">\nBanned patterns found (CLAUDE.md rule 15). Rephrase (use plain words, commas, parens, or colons) or add the 'claudism-check:disable-file' marker if the file legitimately needs the text.\n${body}\n</claudism-check>`,
  },
};
process.stdout.write(JSON.stringify(output));
log(`emitted ${hits.length} claudism(s) in ${rel}`);

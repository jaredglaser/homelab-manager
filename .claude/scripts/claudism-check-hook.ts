#!/usr/bin/env bun
// claudism-check:disable-file - references the marker token in its own output.

// PostToolUse hook: scans the just-edited file for em/en dashes (CLAUDE.md
// rule 15) and reports hits via additionalContext so the model fixes them in
// the same turn. Fails open (exit 0 on any error) so a broken check can't block
// edits. Set CLAUDE_CLAUDISM_HOOK_DEBUG=1 to log to $TMPDIR.

import { readFileSync, existsSync, statSync, appendFileSync } from "node:fs";
import { join, resolve as resolvePath, relative } from "node:path";
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
if (rel.startsWith("..")) {
  exitSilently(`outside project: ${filePath}`);
}

// Generated / vendor dirs.
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", ".next", ".turbo", "coverage",
  ".cache", ".bun", "out",
]);
for (const part of rel.split("/")) {
  if (SKIP_DIRS.has(part)) exitSilently(`skipped dir segment: ${part}`);
}
if (!isScannablePath(rel)) exitSilently(`not scannable: ${rel}`);

if (!existsSync(filePath)) exitSilently("file does not exist post-edit");

let st;
try { st = statSync(filePath); } catch (e) { exitSilently(`stat failed: ${e}`); }
if (!st.isFile()) exitSilently("not a regular file");
if (st.size > 2 * 1024 * 1024) exitSilently(`file too large: ${st.size}b`);

let contents: string;
try {
  contents = readFileSync(filePath, "utf8");
} catch (e) {
  exitSilently(`read failed: ${e}`);
}

const preview = contents.slice(0, 4096);
if (preview.includes("\0")) exitSilently("binary sniff: contains NUL");
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

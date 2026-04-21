#!/usr/bin/env bun
/**
 * Claude Code IDE diagnostics bridge.
 *
 * Two modes:
 * - Hook mode (no argv): reads PostToolUse JSON from stdin and emits
 *   hookSpecificOutput containing <new-diagnostics> for diagnostics that
 *   weren't present the last time this file was processed (dedup cache in
 *   $TMPDIR/claude-diagnostics-cache).
 * - Query mode (--query <path> [--json]): prints current diagnostics for any
 *   file, bypassing the dedup cache. Plain text by default; --json emits the
 *   raw diagnostic array for scripting.
 *
 * Both modes open a short-lived WebSocket to the Claude Code VS Code extension
 * MCP server (URL derived from ~/.claude/ide/<port>.lock). Independent of
 * whether any CLI session has run /ide — each invocation does its own MCP
 * handshake and closes.
 *
 * Hook mode fails open (silent exit 0 on any error) so a misbehaving IDE
 * bridge can't block agent Edits. Query mode prints errors to stderr and
 * exits non-zero.
 *
 * Set CLAUDE_DIAGNOSTICS_HOOK_DEBUG=1 to log to $TMPDIR/claude-diagnostics-hook.log.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync } from "node:fs";
import { join, basename, resolve as resolvePath } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

type HookInput = {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; notebook_path?: string };
};

type Diagnostic = {
  range: { start: { line: number; character: number }; end?: { line: number; character: number } };
  // VS Code extension returns strings ("Error"/"Warning"/"Information"/"Hint");
  // LSP wire format uses numbers (1-4). Accept both.
  severity?: number | string;
  source?: string;
  message: string;
  code?: string | number | { value: string | number; target?: string };
};

const DEBUG = !!process.env.CLAUDE_DIAGNOSTICS_HOOK_DEBUG;
const LOG_PATH = join(tmpdir(), "claude-diagnostics-hook.log");
const log = (msg: string) => {
  if (!DEBUG) return;
  try { appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
};

function exitSilently(reason: string): never {
  log(`skip: ${reason}`);
  process.exit(0);
}

function failQuery(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const argv = process.argv.slice(2);
const queryIdx = argv.indexOf("--query");
const queryArg = queryIdx >= 0 ? argv[queryIdx + 1] : undefined;
const wantJson = argv.includes("--json");
const isQuery = queryArg !== undefined;

let filePath: string;
if (isQuery) {
  filePath = resolvePath(queryArg);
} else {
  let input: HookInput;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch (e) {
    exitSilently(`bad stdin: ${e}`);
  }
  const candidate = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (!candidate) exitSilently("no file_path in tool_input");
  filePath = candidate;
}

const ideDir = join(homedir(), ".claude", "ide");
let lockPath: string | undefined;
const envPort = process.env.CLAUDE_CODE_SSE_PORT;
if (envPort && existsSync(join(ideDir, `${envPort}.lock`))) {
  lockPath = join(ideDir, `${envPort}.lock`);
} else if (existsSync(ideDir)) {
  const locks = readdirSync(ideDir).filter((f) => f.endsWith(".lock"));
  if (locks.length === 1) {
    lockPath = join(ideDir, locks[0]);
  } else if (locks.length > 1) {
    // Multiple VS Code windows (e.g. main repo + worktree). Pick the lock whose
    // workspaceFolders best covers this session's dir; longest-prefix wins so a
    // worktree beats its parent repo. Harness sets CLAUDE_CODE_SSE_PORT, so this
    // branch only fires for --query from a shell.
    const sessionDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    let bestMatchLen = -1;
    for (const name of locks) {
      const candidate = join(ideDir, name);
      try {
        const parsed: { workspaceFolders?: string[] } = JSON.parse(readFileSync(candidate, "utf8"));
        for (const folder of parsed.workspaceFolders ?? []) {
          const covers = sessionDir === folder || sessionDir.startsWith(folder + "/");
          if (covers && folder.length > bestMatchLen) {
            bestMatchLen = folder.length;
            lockPath = candidate;
          }
        }
      } catch { /* skip malformed lock */ }
    }
  }
}
if (!lockPath) {
  if (isQuery) failQuery("No IDE lockfile in ~/.claude/ide/. Is VS Code running with the Claude Code extension active?");
  exitSilently("no IDE lockfile");
}

let lock: { pid: number; authToken: string; workspaceFolders?: string[] };
try {
  lock = JSON.parse(readFileSync(lockPath, "utf8"));
} catch (e) {
  if (isQuery) failQuery(`Bad lockfile ${lockPath}: ${e}`);
  exitSilently(`bad lockfile: ${e}`);
}

const port = Number(basename(lockPath, ".lock"));
const wsUrl = `ws://127.0.0.1:${port}`;
const fileUri = pathToFileURL(filePath).toString();

log(`mode=${isQuery ? "query" : "hook"} file=${filePath} port=${port}`);

async function fetchDiagnostics(): Promise<Diagnostic[] | null> {
  return new Promise((done) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl, {
        headers: { "x-claude-code-ide-authorization": lock.authToken },
      });
    } catch (e) {
      log(`ws ctor threw: ${e}`);
      return done(null);
    }

    const deadline = setTimeout(() => {
      log("ws deadline exceeded");
      try { ws.close(); } catch {}
      done(null);
    }, 5000);

    let step: "init" | "call" | "done" = "init";

    ws.onopen = () => {
      log("ws open; sending initialize");
      ws.send(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "diagnostics-hook", version: "1.0.0" },
        },
      }));
    };

    ws.onmessage = (ev) => {
      const raw = String(ev.data);
      log(`ws msg (${raw.length}b): ${raw.slice(0, 800)}`);
      let msg: { id?: number; result?: { content?: Array<{ type: string; text: string }> }; error?: unknown };
      try { msg = JSON.parse(raw); } catch { log("ws msg: not JSON"); return; }
      if (msg.id === 1 && step === "init") {
        ws.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
        step = "call";
        ws.send(JSON.stringify({
          jsonrpc: "2.0", id: 2, method: "tools/call",
          params: { name: "getDiagnostics", arguments: { uri: fileUri } },
        }));
        log("ws: sent tools/call getDiagnostics");
        return;
      }
      if (msg.id === 2 && step === "call") {
        step = "done";
        clearTimeout(deadline);
        try { ws.close(); } catch {}
        if (msg.error) { log(`tool error: ${JSON.stringify(msg.error)}`); return done(null); }
        const text = msg.result?.content?.[0]?.text;
        if (!text) {
          log(`result has no text; full result=${JSON.stringify(msg.result).slice(0, 500)}`);
          return done([]);
        }
        try {
          const parsed = JSON.parse(text) as Array<{ uri: string; diagnostics: Diagnostic[] }>;
          const summary = parsed.map((p) => p.uri + "#" + p.diagnostics.length).join(", ").slice(0, 500);
          log(`parsed ${parsed.length} uri entr(ies): ${summary}`);
          const match = parsed.find((p) => p.uri === fileUri);
          if (!match) {
            const available = parsed.map((p) => p.uri).join(", ").slice(0, 500);
            log(`no uri match for ${fileUri}; available: ${available}`);
          }
          done(match?.diagnostics ?? []);
        } catch (e) {
          log(`parse result err: ${e}; raw=${text.slice(0, 500)}`);
          done(null);
        }
      }
    };

    ws.onerror = (ev) => {
      const errMsg = (ev as { message?: string }).message;
      log(`ws error: ${errMsg ?? JSON.stringify(ev).slice(0, 300)}`);
      clearTimeout(deadline);
      done(null);
    };
    ws.onclose = (ev) => {
      if (step === "done") {
        log("ws closed after done");
        return;
      }
      log(`ws closed early code=${ev.code} reason=${ev.reason} wasClean=${ev.wasClean}`);
      clearTimeout(deadline);
      done(null);
    };
  });
}

const SEVERITY_LABELS: Record<string, string> = {
  "1": "ERROR",
  "2": "WARN",
  "3": "INFO",
  "4": "HINT",
  Error: "ERROR",
  Warning: "WARN",
  Information: "INFO",
  Hint: "HINT",
};
const severityName = (s?: number | string): string =>
  SEVERITY_LABELS[String(s ?? "")] ?? "?";

const formatDiag = (d: Diagnostic): string => {
  const line = d.range.start.line + 1;
  const col = d.range.start.character + 1;
  const rawCode = typeof d.code === "object" && d.code ? d.code.value : d.code;
  const codeStr = rawCode ? ` [${rawCode}]` : "";
  const src = d.source ? `(${d.source}) ` : "";
  return `  L${line}:${col} ${severityName(d.severity)} ${src}${d.message}${codeStr}`;
};

const diagnostics = await fetchDiagnostics();

if (isQuery) {
  if (wantJson) {
    process.stdout.write(JSON.stringify(diagnostics ?? [], null, 2) + "\n");
  } else if (!diagnostics || diagnostics.length === 0) {
    console.log(`(no diagnostics for ${filePath})`);
  } else {
    for (const d of diagnostics) console.log(formatDiag(d));
  }
  process.exit(0);
}

// Hook mode: no filter — inject everything, but dedup against the previous run
// so we only surface net-new findings after each edit.
if (!diagnostics || diagnostics.length === 0) exitSilently("no diagnostics");

const cacheDir = join(tmpdir(), "claude-diagnostics-cache");
try { mkdirSync(cacheDir, { recursive: true }); } catch {}
const cacheKey = createHash("sha1").update(filePath).digest("hex");
const cacheFile = join(cacheDir, `${cacheKey}.json`);

const sig = (d: Diagnostic): string => {
  const code = typeof d.code === "object" && d.code ? d.code.value : d.code ?? "";
  return `${d.range.start.line}:${d.range.start.character}:${d.source ?? ""}:${code}:${d.message}`;
};
const currentSigs = diagnostics.map(sig);

let previous: string[] = [];
if (existsSync(cacheFile)) {
  try { previous = JSON.parse(readFileSync(cacheFile, "utf8")); } catch {}
}
try { writeFileSync(cacheFile, JSON.stringify(currentSigs)); } catch {}

const prevSet = new Set(previous);
const newOnly = diagnostics.filter((d) => !prevSet.has(sig(d)));
if (newOnly.length === 0) exitSilently("no new diagnostics since last run");

const body = newOnly.map(formatDiag).join("\n");
const output = {
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: `<new-diagnostics file="${filePath}">\n${body}\n</new-diagnostics>`,
  },
};
process.stdout.write(JSON.stringify(output));
log(`emitted ${newOnly.length} new diagnostic(s)`);

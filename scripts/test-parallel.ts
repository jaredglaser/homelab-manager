#!/usr/bin/env bun
/**
 * Run the whole repo's bun test suite as concurrent per-file shards.
 *
 * `bun test --isolate` executes test files strictly sequentially (~27s for
 * ~270 files on a 16-core machine, user time ~= wall time). This script
 * splits the file list round-robin across N `bun test --isolate` child
 * processes, cutting wall time to ~5-6s while keeping every file in its own
 * isolated runtime, so `mock.module()` still cannot leak across files.
 *
 * File discovery mirrors bun's default test matcher over
 * `git ls-files --cached --others --exclude-standard`, so untracked new test
 * files are included and gitignored trees (.worktrees, node_modules) are not.
 *
 *   bun run test:all              # shard the full repo (root + agent)
 *   bun run test:all -- src/lib   # shard only files whose path contains "src/lib"
 *   bun run test:all --shards=4   # override the shard count
 *
 * Coverage runs (`bun run test`, `test:coverage:agent`) stay single-process:
 * Bun cannot merge V8 coverage across processes, and the coverage gate needs
 * one table.
 */
import { $ } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(import.meta.dir, "..", ".tmp", "test-parallel");
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|_test\.[cm]?[jt]sx?$/;

const shardArg = process.argv.find((a) => a.startsWith("--shards="));
const filters = process.argv.slice(2).filter((a) => !a.startsWith("--") && a !== shardArg);
const shardCount = shardArg
  ? Number(shardArg.slice("--shards=".length))
  : Math.max(1, Math.min(cpus().length, 12));

if (!Number.isInteger(shardCount) || shardCount < 1) {
  console.error(`--shards must be a positive integer, got "${shardArg?.slice("--shards=".length)}"`);
  process.exit(1);
}

const toplevel = (await $`git rev-parse --show-toplevel`.quiet().text()).trim();
if (toplevel !== process.cwd()) {
  console.error(`Run from the repo root (${toplevel}), not ${process.cwd()}`);
  process.exit(1);
}

const listed = await $`git ls-files --cached --others --exclude-standard`.quiet().text();
const files = listed
  .split("\n")
  .map((f) => f.trim())
  .filter((f) => TEST_FILE.test(f) && (filters.length === 0 || filters.some((s) => f.includes(s))));

if (files.length === 0) {
  console.error(`No test files matched${filters.length > 0 ? ` filters: ${filters.join(", ")}` : ""}`);
  process.exit(1);
}

const shards: string[][] = Array.from({ length: Math.min(shardCount, files.length) }, () => []);
// Longest-processing-time-first over file size: test duration tracks file size
// closely enough that this keeps shard wall times within ~1s of each other,
// where plain round-robin let one shard run 2x longer than the rest.
const sized = files.map((f) => ({ f, size: Bun.file(f).size }));
sized.sort((a, b) => b.size - a.size);
const loads = shards.map(() => 0);
for (const { f, size } of sized) {
  const i = loads.indexOf(Math.min(...loads));
  shards[i].push(f);
  loads[i] += size;
}
for (const shard of shards) shard.sort();

rmSync(LOG_DIR, { recursive: true, force: true });
mkdirSync(LOG_DIR, { recursive: true });

const startedAt = performance.now();
const results = await Promise.all(
  shards.map(async (shardFiles, i) => {
    const proc = Bun.spawn(["bun", "test", "--isolate", ...shardFiles], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const output = stdout + stderr;
    const logPath = join(LOG_DIR, `shard-${i}.log`);
    await Bun.write(logPath, output);
    const pass = /(?:^|\n)\s*(\d+)\s+pass\b/.exec(output)?.[1];
    const fail = /(?:^|\n)\s*(\d+)\s+fail\b/.exec(output)?.[1];
    const ran = /(?:^|\n)Ran \d+ tests across \d+ files\. \[([^\]]+)\]/.exec(output)?.[1];
    return { i, code, pass: Number(pass ?? 0), fail: Number(fail ?? 0), ran, logPath };
  }),
);

const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
const totalPass = results.reduce((sum, r) => sum + r.pass, 0);
const totalFail = results.reduce((sum, r) => sum + r.fail, 0);

for (const r of results) {
  const summary = r.ran ? `${r.pass} pass, ${r.fail} fail in ${r.ran}` : `no summary, exit ${r.code}`;
  console.log(`shard ${r.i}: ${summary}${r.fail > 0 || r.code !== 0 ? ` (full output: ${r.logPath})` : ""}`);
}

if (totalFail > 0 || results.some((r) => r.code !== 0)) {
  for (const r of results.filter((r) => r.fail > 0 || r.code !== 0)) {
    console.error(`\n===== shard ${r.i} failures (tail of ${r.logPath}) =====`);
    const lines = (await Bun.file(r.logPath).text()).split("\n");
    console.error(lines.slice(-80).join("\n"));
  }
}

console.log(`\nTotal: ${totalPass} pass, ${totalFail} fail across ${files.length} files in ${elapsed}s (${shards.length} shards)`);
process.exit(totalFail > 0 || results.some((r) => r.code !== 0) ? 1 : 0);

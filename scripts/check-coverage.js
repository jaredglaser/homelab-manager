#!/usr/bin/env node

/**
 * Check test results and coverage against minimum thresholds.
 * Reads Bun's text test + coverage output from stdin, echoes it so the
 * results stay visible in logs, then enforces both a zero-failure gate and
 * the coverage minimums.
 *
 * Usage:
 *   bun test --coverage 2>&1 | node scripts/check-coverage.js
 */

import { readFileSync } from 'node:fs';

const THRESHOLDS = {
  lines: 98,
  // Bun uses V8's built-in coverage, which counts class field initializers,
  // framework wrapper callbacks (e.g. createServerFn .handler()), and Zod
  // .refine()/.transform() callbacks as separate functions. These can show
  // as "uncovered" even when every line is hit, because V8 distinguishes
  // defining a callable (line hit) from entering it (function hit).
  // A 94% floor accounts for this instrumentation noise.
  functions: 94,
  // Note: Bun doesn't report branch coverage yet
};

let output;
try {
  output = readFileSync(0, 'utf-8'); // fd 0 is stdin
} catch {
  console.error('❌ Failed to read test output from stdin');
  process.exit(1);
}

// Bun's output was consumed by this script; re-emit it so failures and the
// coverage table remain visible in CI logs.
process.stdout.write(output);

let failed = false;

// A single piped stream can hide a non-zero bun exit, so gate on the printed
// summary directly. Bun prints one "<n> fail" line at the end of the run.
const failMatches = [...output.matchAll(/^\s*(\d+)\s+fail\b/gm)];
const failCount = failMatches.length > 0 ? Number(failMatches.at(-1)[1]) : null;

if (failCount === null) {
  console.error('\n❌ Could not find a test summary ("<n> fail") in the output');
  console.error('The test run likely crashed before reporting; treating as failed.');
  failed = true;
} else if (failCount > 0) {
  console.error(`\n❌ ${failCount} test${failCount === 1 ? '' : 's'} failed`);
  const failingTests = [...output.matchAll(/^\(fail\) .+$/gm)].map((m) => m[0]);
  for (const line of failingTests) {
    console.error(`   ${line}`);
  }
  failed = true;
}

const match = output.match(/All files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|/);

if (!match) {
  console.error('\n❌ Could not parse coverage from test output');
  console.error('Expected format: "All files | <functions%> | <lines%> |"');
  process.exit(1);
}

const coverage = {
  functions: Number.parseFloat(match[1]),
  lines: Number.parseFloat(match[2]),
};

console.log('\n📊 Coverage Summary:');
console.log(`   Functions: ${coverage.functions.toFixed(2)}% (threshold: ${THRESHOLDS.functions}%)`);
console.log(`   Lines: ${coverage.lines.toFixed(2)}% (threshold: ${THRESHOLDS.lines}%)`);

if (coverage.functions < THRESHOLDS.functions) {
  console.error(`\n❌ Function coverage ${coverage.functions.toFixed(2)}% is below threshold ${THRESHOLDS.functions}%`);
  console.error(`   Need ${(THRESHOLDS.functions - coverage.functions).toFixed(2)}% more function coverage`);
  failed = true;
}

if (coverage.lines < THRESHOLDS.lines) {
  console.error(`\n❌ Line coverage ${coverage.lines.toFixed(2)}% is below threshold ${THRESHOLDS.lines}%`);
  console.error(`   Need ${(THRESHOLDS.lines - coverage.lines).toFixed(2)}% more line coverage`);
  failed = true;
}

if (failed) {
  console.error('\n💔 Test/coverage check FAILED');
  process.exit(1);
}

console.log('\n✅ Test and coverage checks PASSED');
process.exit(0);

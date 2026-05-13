#!/usr/bin/env node

/**
 * Check test coverage against minimum thresholds.
 * Reads Bun's text coverage output from stdin and enforces minimums.
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
  // A 95% floor accounts for this instrumentation noise.
  functions: 94,
  // Note: Bun doesn't report branch coverage yet
};

// Read from stdin (piped from bun test --coverage)
let output;
try {
  output = readFileSync(0, 'utf-8'); // fd 0 is stdin
} catch (error) {
  console.error('❌ Failed to read coverage from stdin');
  process.exit(1);
}

// Parse coverage from output
// Format: "All files                                  |   93.32 |   93.27 |"
// Note: there may be many spaces between "All files" and the first |
const match = output.match(/All files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|/);

if (!match) {
  console.error('❌ Could not parse coverage from test output');
  console.error('Expected format: "All files | <functions%> | <lines%> |"');
  process.exit(1);
}

const [, functionsPercent, linesPercent] = match;
const coverage = {
  functions: Number.parseFloat(functionsPercent),
  lines: Number.parseFloat(linesPercent),
};

console.log('\n📊 Coverage Summary:');
console.log(`   Functions: ${coverage.functions.toFixed(2)}% (threshold: ${THRESHOLDS.functions}%)`);
console.log(`   Lines: ${coverage.lines.toFixed(2)}% (threshold: ${THRESHOLDS.lines}%)`);

let failed = false;

if (coverage.functions < THRESHOLDS.functions) {
  console.error(`\n❌ Function coverage ${coverage.functions.toFixed(2)}% is below threshold ${THRESHOLDS.functions}%`);
  const deficit = THRESHOLDS.functions - coverage.functions;
  console.error(`   Need ${deficit.toFixed(2)}% more function coverage`);
  failed = true;
}

if (coverage.lines < THRESHOLDS.lines) {
  console.error(`\n❌ Line coverage ${coverage.lines.toFixed(2)}% is below threshold ${THRESHOLDS.lines}%`);
  const deficit = THRESHOLDS.lines - coverage.lines;
  console.error(`   Need ${deficit.toFixed(2)}% more line coverage`);
  failed = true;
}

if (failed) {
  console.error('\n💔 Coverage check FAILED');
  console.error('Please add tests to improve coverage before committing.');
  process.exit(1);
}

console.log('\n✅ Coverage check PASSED');
console.log('All coverage thresholds met!');
process.exit(0);

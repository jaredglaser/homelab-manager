#!/usr/bin/env bun
/**
 * Read quarantine-update-report.json and rewrite package.json files to use
 * exact (caret-free) pins of the chosen versions. This prevents bun install
 * from resolving past the 30-day-quarantine versions.
 */
import { readFileSync, writeFileSync } from 'node:fs';

interface DepReport {
  pkg: string;
  current: string;
  chosen: string | null;
  note?: string;
}

interface FullReport {
  cutoff: string;
  root: DepReport[];
  agent: DepReport[];
}

const report: FullReport = JSON.parse(readFileSync('quarantine-update-report.json', 'utf8'));

function applyExactPins(path: string, deps: DepReport[]) {
  const pkg = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  let count = 0;
  for (const d of deps) {
    if (!d.chosen) continue;
    let replaced = false;
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      const bag = pkg[section];
      if (!bag || typeof bag !== 'object' || !(d.pkg in (bag as Record<string, unknown>))) continue;
      const bagTyped = bag as Record<string, string>;
      if (bagTyped[d.pkg] !== d.chosen) {
        bagTyped[d.pkg] = d.chosen;
        count++;
      }
      replaced = true;
      break;
    }
    if (!replaced) {
      console.error(`  WARN: could not find ${d.pkg} entry in ${path}`);
    }
  }
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  console.info(`[${path}] pinned ${count} entries to exact versions`);
}

applyExactPins('package.json', report.root);
applyExactPins('agent/package.json', report.agent);

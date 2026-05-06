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
  let raw = readFileSync(path, 'utf8');
  let count = 0;
  for (const d of deps) {
    if (!d.chosen) continue;
    const candidates = [
      `"${d.pkg}": "^${d.chosen}"`,
      `"${d.pkg}": "~${d.chosen}"`,
      `"${d.pkg}": "${d.current}"`,
    ];
    let replaced = false;
    for (const search of candidates) {
      if (raw.includes(search)) {
        const replace = `"${d.pkg}": "${d.chosen}"`;
        if (search === replace) { replaced = true; break; }
        raw = raw.replace(search, replace);
        replaced = true;
        count++;
        break;
      }
    }
    if (!replaced) {
      console.error(`  WARN: could not find ${d.pkg} entry in ${path}`);
    }
  }
  writeFileSync(path, raw);
  console.error(`[${path}] pinned ${count} entries to exact versions`);
}

applyExactPins('package.json', report.root);
applyExactPins('agent/package.json', report.agent);

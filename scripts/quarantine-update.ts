#!/usr/bin/env bun
/**
 * One-off: pick the highest stable semver published on or before CUTOFF for each dep,
 * across both root and agent package.json. Writes a JSON report and rewrites package.json
 * pins. Does NOT run install. Skips packages that are npm aliases (e.g. nitro-nightly).
 */
import { readFileSync, writeFileSync } from 'node:fs';

const CUTOFF = '2026-04-05T23:59:59.999Z';
const cutoffMs = new Date(CUTOFF).getTime();

interface DepReport {
  pkg: string;
  current: string;
  chosen: string | null;
  chosenPublishedAt: string | null;
  latestStable: string | null;
  latestStablePublishedAt: string | null;
  isMajorBump: boolean;
  note?: string;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseSemver(v: string): [number, number, number, string | null] | null {
  const m = SEMVER_RE.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? null];
}

function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return a.localeCompare(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return (pa[i] as number) - (pb[i] as number);
  }
  if (pa[3] === null && pb[3] !== null) return 1;
  if (pa[3] !== null && pb[3] === null) return -1;
  if (pa[3] && pb[3]) return pa[3].localeCompare(pb[3]);
  return 0;
}

function isStable(v: string): boolean {
  const p = parseSemver(v);
  return p !== null && p[3] === null;
}

function stripRange(spec: string): string {
  return spec.replace(/^[~^=><\s]+/, '');
}

async function fetchPackument(pkg: string): Promise<{
  versions: Record<string, unknown>;
  time: Record<string, string>;
} | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg).replace('%40', '@')}`);
    if (!res.ok) return null;
    return await res.json() as { versions: Record<string, unknown>; time: Record<string, string> };
  } catch {
    return null;
  }
}

async function pickVersion(pkg: string, currentSpec: string): Promise<DepReport> {
  const current = stripRange(currentSpec);
  const report: DepReport = {
    pkg,
    current: currentSpec,
    chosen: null,
    chosenPublishedAt: null,
    latestStable: null,
    latestStablePublishedAt: null,
    isMajorBump: false,
  };

  if (currentSpec.startsWith('npm:')) {
    report.note = 'npm alias, skipped';
    return report;
  }

  const packument = await fetchPackument(pkg);
  if (!packument) {
    report.note = 'registry fetch failed';
    return report;
  }

  const allVersions = Object.keys(packument.versions);
  const stable = allVersions.filter(isStable);

  const latestStable = [...stable].sort(compareSemver).at(-1);
  if (latestStable) {
    report.latestStable = latestStable;
    report.latestStablePublishedAt = packument.time[latestStable] ?? null;
  }

  const eligible = stable.filter((v) => {
    const t = packument.time[v];
    return t && new Date(t).getTime() <= cutoffMs;
  });
  const chosen = eligible.sort(compareSemver).at(-1);

  if (!chosen) {
    report.note = `no stable version published before ${CUTOFF}`;
    return report;
  }

  report.chosen = chosen;
  report.chosenPublishedAt = packument.time[chosen] ?? null;

  const cur = parseSemver(current);
  const ch = parseSemver(chosen);
  if (cur && ch && cur[0] !== ch[0]) {
    report.isMajorBump = true;
  }

  if (chosen === current) {
    report.note = 'already at chosen version';
  }

  return report;
}

async function batchMap<T, U>(items: T[], limit: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const results: U[] = [];
  for (let i = 0; i < items.length; i += limit) {
    results.push(...await Promise.all(items.slice(i, i + limit).map(fn)));
  }
  return results;
}

async function processPackageJson(path: string): Promise<DepReport[]> {
  const raw = readFileSync(path, 'utf8');
  const pkgJson = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  const allDeps: Array<[string, string]> = [];
  for (const [name, spec] of Object.entries(pkgJson.dependencies ?? {})) {
    allDeps.push([name, spec]);
  }
  for (const [name, spec] of Object.entries(pkgJson.devDependencies ?? {})) {
    allDeps.push([name, spec]);
  }

  console.error(`[${path}] resolving ${allDeps.length} packages...`);

  const results = await batchMap(allDeps, 10, ([n, s]) => pickVersion(n, s));

  let updated = raw;
  for (let i = 0; i < allDeps.length; i++) {
    const [name, oldSpec] = allDeps[i];
    const r = results[i];
    if (!r.chosen || r.chosen === stripRange(oldSpec)) continue;
    const prefix = oldSpec.startsWith('^') ? '^' : oldSpec.startsWith('~') ? '~' : '^';
    const newSpec = `${prefix}${r.chosen}`;
    const search = `"${name}": "${oldSpec}"`;
    const replace = `"${name}": "${newSpec}"`;
    if (!updated.includes(search)) {
      console.error(`  WARN: could not find ${search} in ${path}`);
      continue;
    }
    updated = updated.replace(search, replace);
    console.error(`  ${name}: ${oldSpec} -> ${newSpec}${r.isMajorBump ? ' (MAJOR)' : ''}`);
  }
  writeFileSync(path, updated);

  return results;
}

const rootResults = await processPackageJson('package.json');
const agentResults = await processPackageJson('agent/package.json');

const fullReport = {
  cutoff: CUTOFF,
  root: rootResults,
  agent: agentResults,
};

writeFileSync('quarantine-update-report.json', JSON.stringify(fullReport, null, 2));
console.error('\nReport written to quarantine-update-report.json');

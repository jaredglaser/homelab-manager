#!/usr/bin/env bun
// Usage: bun scripts/pr-ready.ts [<pr number>...]   (every open PR when none given)
//        bun scripts/pr-ready.ts --lint-body        (PR Body Lint, reads $GITHUB_EVENT_PATH)
// Reads GH_TOKEN or GITHUB_TOKEN when set, and GITHUB_REPOSITORY (default
// jaredglaser/homelab-manager).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fetchWithRetry } from './fetch-retry';

export const COULD_NOT_CHECK = 'Could not check. Run it again.';

export type CheckState = 'passed' | 'failed' | 'running' | 'missing';

export interface GhPull {
  number: number;
  draft: boolean;
  body: string;
  author: string;
  headRef: string;
  headSha: string;
  baseRef: string;
}

export interface GhCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  appId: number | null;
}

export interface GhStatus {
  context: string;
  state: string;
}

export interface GhComparison {
  baseSha: string;
  mergeBaseSha: string;
  behindBy: number;
}

export interface RequiredCheck {
  context: string;
  integrationId: number | null;
}

export interface GhApi {
  getPull(repo: string, number: number): Promise<GhPull>;
  listOpenPulls(repo: string): Promise<GhPull[]>;
  getBranchRules(repo: string, branch: string): Promise<unknown[]>;
  compare(repo: string, base: string, headSha: string): Promise<GhComparison>;
  listCheckRuns(repo: string, sha: string): Promise<GhCheckRun[]>;
  listStatuses(repo: string, sha: string): Promise<GhStatus[]>;
}

export interface GitApi {
  fetchCommits(shas: string[]): Promise<void>;
  conflictingFiles(mergeBase: string, base: string, head: string): Promise<number>;
}

export interface Facts {
  draft: boolean;
  baseRef: string;
  headSha: string;
  stackedOn: number | null;
  conflictFiles: number;
  behindBy: number;
  checks: Array<{ name: string; state: CheckState }>;
  acceptanceSha: string | null;
}

export interface Verdict {
  line: string;
  error?: string;
}

export interface PrResult {
  number: number;
  headSha: string;
  verdict: Verdict;
}

const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const RE_ACCEPTANCE = /^##[ \t]+Acceptance \(verified at ([^)\r\n]*)\)[ \t]*$/gm;
const RE_SHA = /^[0-9a-f]{7,40}$/;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function requiredChecksFromRules(rules: unknown[]): RequiredCheck[] {
  const out: RequiredCheck[] = [];
  for (const rule of rules as Array<{ type?: string; parameters?: { required_status_checks?: unknown } }>) {
    if (rule.type !== 'required_status_checks') continue;
    const checks = rule.parameters?.required_status_checks;
    if (!Array.isArray(checks)) continue;
    for (const c of checks as Array<{ context?: unknown; integration_id?: unknown }>) {
      if (typeof c.context !== 'string') continue;
      if (out.some((o) => o.context === c.context)) continue;
      out.push({ context: c.context, integrationId: typeof c.integration_id === 'number' ? c.integration_id : null });
    }
  }
  return out;
}

export function checkState(required: RequiredCheck, runs: GhCheckRun[], statuses: GhStatus[]): CheckState {
  const matching = runs
    .filter((r) => r.name === required.context)
    .filter((r) => required.integrationId === null || r.appId === required.integrationId);
  if (matching.length > 0) {
    const newest = matching.reduce((a, b) => (b.id > a.id ? b : a));
    if (newest.status !== 'completed') return 'running';
    return PASSING_CONCLUSIONS.has(newest.conclusion ?? '') ? 'passed' : 'failed';
  }
  const status = statuses.find((s) => s.context === required.context);
  if (!status) return 'missing';
  if (status.state === 'success') return 'passed';
  if (status.state === 'pending') return 'running';
  return 'failed';
}

export function acceptanceSha(body: string): string | null {
  const matches = [...body.matchAll(RE_ACCEPTANCE)];
  return matches.length > 0 ? matches.at(-1)![1].trim() : null;
}

export function acceptanceIsCurrent(verifiedAt: string, headSha: string): boolean {
  const sha = verifiedAt.toLowerCase();
  return RE_SHA.test(sha) && headSha.toLowerCase().startsWith(sha);
}

export function criteriaApply(pull: Pick<GhPull, 'author' | 'headRef'>): boolean {
  return pull.author !== 'dependabot[bot]' && !pull.headRef.startsWith('release-please--');
}

export function staleCriteria(verifiedAt: string | null, headSha: string): string | null {
  if (verifiedAt === null || acceptanceIsCurrent(verifiedAt, headSha)) return null;
  const shown = RE_SHA.test(verifiedAt.toLowerCase()) ? verifiedAt.slice(0, 7) : verifiedAt;
  return `Not ready: criteria were verified at ${shown} and the PR has moved since.`;
}

export function stackedOn(pull: GhPull, openPulls: GhPull[]): number | null {
  const parent = openPulls.find((p) => p.number !== pull.number && p.headRef === pull.baseRef);
  return parent ? parent.number : null;
}

export function reasons(facts: Facts): string[] {
  const out: string[] = [];
  if (facts.draft) out.push('Not ready: this PR is a draft.');
  if (facts.stackedOn !== null) out.push(`Not ready: stacked on #${facts.stackedOn}. Merge #${facts.stackedOn} first.`);
  if (facts.conflictFiles > 0) {
    out.push(`Not ready: conflicts with ${facts.baseRef} in ${plural(facts.conflictFiles, 'file')}.`);
  }
  for (const c of facts.checks) if (c.state === 'failed') out.push(`Not ready: ${c.name} failed.`);
  for (const c of facts.checks) if (c.state === 'running') out.push(`Not ready: ${c.name} is still running.`);
  for (const c of facts.checks) if (c.state === 'missing') out.push(`Not ready: ${c.name} has not run on this commit.`);
  const stale = staleCriteria(facts.acceptanceSha, facts.headSha);
  if (stale) out.push(stale);
  return out;
}

export function evaluate(facts: Facts): Verdict {
  const [first] = reasons(facts);
  if (first) return { line: first };
  if (facts.behindBy === 0) return { line: 'Ready' };
  return { line: `Ready. ${plural(facts.behindBy, 'commit')} behind ${facts.baseRef}, no conflicts.` };
}

export function couldNotCheck(error: unknown): Verdict {
  return { line: COULD_NOT_CHECK, error: error instanceof Error ? error.message : String(error) };
}

export async function gatherFacts(
  repo: string,
  pull: GhPull,
  openPulls: GhPull[],
  api: GhApi,
  git: GitApi,
): Promise<Facts> {
  const required = requiredChecksFromRules(await api.getBranchRules(repo, pull.baseRef));
  const [runs, statuses, comparison] = await Promise.all([
    api.listCheckRuns(repo, pull.headSha),
    api.listStatuses(repo, pull.headSha),
    api.compare(repo, pull.baseRef, pull.headSha),
  ]);
  await git.fetchCommits([comparison.baseSha, comparison.mergeBaseSha, pull.headSha]);
  const conflictFiles = await git.conflictingFiles(comparison.mergeBaseSha, comparison.baseSha, pull.headSha);
  return {
    draft: pull.draft,
    baseRef: pull.baseRef,
    headSha: pull.headSha,
    stackedOn: stackedOn(pull, openPulls),
    conflictFiles,
    behindBy: comparison.behindBy,
    checks: required.map((r) => ({ name: r.context, state: checkState(r, runs, statuses) })),
    acceptanceSha: criteriaApply(pull) ? acceptanceSha(pull.body) : null,
  };
}

export async function checkPull(
  repo: string,
  pull: GhPull,
  openPulls: GhPull[],
  api: GhApi,
  git: GitApi,
): Promise<PrResult> {
  let verdict: Verdict;
  try {
    verdict = evaluate(await gatherFacts(repo, pull, openPulls, api, git));
  } catch (err) {
    verdict = couldNotCheck(err);
  }
  return { number: pull.number, headSha: pull.headSha, verdict };
}

export function sessionLine(result: PrResult): string {
  return `${result.verdict.line} #${result.number} at ${result.headSha.slice(0, 7)}`;
}

export function parseNumbers(argv: string[]): number[] {
  return argv.map((arg) => {
    if (!/^#?\d+$/.test(arg)) throw new Error(`Unknown argument: ${arg}`);
    return Number(arg.replace('#', ''));
  });
}

export function lintBody(event: unknown): { ok: boolean; message: string } {
  const pr = (event as { pull_request?: RawPull } | null)?.pull_request;
  if (!pr) return { ok: false, message: 'FAIL: the event payload has no pull_request.' };
  const pull = toPull(pr);
  if (!criteriaApply(pull)) return { ok: true, message: 'OK: release-please and Dependabot PRs carry no Acceptance table.' };
  const verifiedAt = acceptanceSha(pull.body);
  if (verifiedAt === null) return { ok: true, message: 'OK: the description has no Acceptance table.' };
  const stale = staleCriteria(verifiedAt, pull.headSha);
  if (stale) return { ok: false, message: stale };
  return { ok: true, message: `OK: criteria were verified at the head commit ${pull.headSha.slice(0, 7)}.` };
}

function escapeAnnotation(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export function runBodyLint(eventText: string, out: (line: string) => void): number {
  const result = lintBody(JSON.parse(eventText));
  if (result.ok) {
    out(result.message);
    return 0;
  }
  out(`::error title=PR Body Lint::${escapeAnnotation(result.message)}`);
  out(result.message);
  return 1;
}

interface RawPull {
  number: number;
  draft?: boolean;
  body: string | null;
  user: { login: string } | null;
  head: { ref: string; sha: string };
  base: { ref: string };
}

function toPull(p: RawPull): GhPull {
  return {
    number: p.number,
    draft: p.draft === true,
    body: p.body ?? '',
    author: p.user?.login ?? '',
    headRef: p.head.ref,
    headSha: p.head.sha,
    baseRef: p.base.ref,
  };
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function realApi(
  token: string | undefined,
  fetchImpl: FetchLike = fetch,
  sleep?: (ms: number) => Promise<void>,
): GhApi {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = 'Bearer ' + token;
  const base = 'https://api.github.com/repos/';
  async function getJson(path: string): Promise<unknown> {
    const res = await fetchWithRetry(fetchImpl, base + path, { headers }, sleep);
    if (!res.ok) throw new Error(`GET ${path} failed: HTTP ${res.status}`);
    return await res.json();
  }
  return {
    async getPull(repo, number) {
      return toPull((await getJson(`${repo}/pulls/${number}`)) as RawPull);
    },
    async listOpenPulls(repo) {
      const out: GhPull[] = [];
      for (let page = 1; ; page++) {
        const batch = (await getJson(`${repo}/pulls?state=open&per_page=100&page=${page}`)) as RawPull[];
        out.push(...batch.map(toPull));
        if (batch.length < 100) return out;
      }
    },
    async getBranchRules(repo, branch) {
      return (await getJson(`${repo}/rules/branches/${encodeURIComponent(branch)}?per_page=100`)) as unknown[];
    },
    async compare(repo, baseRef, headSha) {
      const c = (await getJson(`${repo}/compare/${encodeURIComponent(baseRef)}...${headSha}?per_page=1`)) as {
        behind_by: number;
        base_commit: { sha: string };
        merge_base_commit: { sha: string };
      };
      return { baseSha: c.base_commit.sha, mergeBaseSha: c.merge_base_commit.sha, behindBy: c.behind_by };
    },
    async listCheckRuns(repo, sha) {
      const out: GhCheckRun[] = [];
      for (let page = 1; ; page++) {
        const batch = (await getJson(`${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`)) as {
          check_runs: Array<{ id: number; name: string; status: string; conclusion: string | null; app: { id: number } | null }>;
        };
        out.push(
          ...batch.check_runs.map((r) => ({
            id: r.id,
            name: r.name,
            status: r.status,
            conclusion: r.conclusion,
            appId: r.app?.id ?? null,
          })),
        );
        if (batch.check_runs.length < 100) return out;
      }
    },
    async listStatuses(repo, sha) {
      const combined = (await getJson(`${repo}/commits/${sha}/status?per_page=100`)) as {
        statuses: Array<{ context: string; state: string }>;
      };
      return combined.statuses.map((s) => ({ context: s.context, state: s.state }));
    },
  };
}

export function realGit(cwd: string): GitApi {
  async function git(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }
  return {
    async fetchCommits(shas) {
      const missing: string[] = [];
      for (const sha of new Set(shas)) {
        if ((await git(['cat-file', '-e', `${sha}^{commit}`])).code !== 0) missing.push(sha);
      }
      if (missing.length === 0) return;
      const res = await git(['fetch', '--no-tags', '--quiet', 'origin', ...missing]);
      if (res.code !== 0) throw new Error(`git fetch failed: ${res.stderr.trim()}`);
    },
    async conflictingFiles(mergeBase, base, head) {
      const res = await git(['merge-tree', '--write-tree', '--name-only', '--no-messages', `--merge-base=${mergeBase}`, base, head]);
      const [tree, ...rest] = res.stdout.split('\n');
      const files = new Set(rest.filter((l) => l !== '')).size;
      // merge-tree also exits 1 for a commit it cannot read, with no tree on stdout.
      const merged = /^[0-9a-f]{40,64}$/.test(tree) && (res.code === 0 || (res.code === 1 && files > 0));
      if (!merged) throw new Error(`git merge-tree failed: ${res.stderr.trim() || `exit ${res.code}`}`);
      return res.code === 0 ? 0 : files;
    },
  };
}

export interface CliDeps {
  repo: string;
  api: GhApi;
  git: GitApi;
  out: (line: string) => void;
  err: (line: string) => void;
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const { repo, api, git, out, err } = deps;
  const numbers = parseNumbers(argv);
  let openPulls: GhPull[];
  const pulls: GhPull[] = [];
  try {
    openPulls = await api.listOpenPulls(repo);
    if (numbers.length === 0) pulls.push(...[...openPulls].sort((a, b) => b.number - a.number));
    for (const number of numbers) {
      pulls.push(openPulls.find((p) => p.number === number) ?? (await api.getPull(repo, number)));
    }
  } catch (e) {
    for (const number of numbers) out(`${COULD_NOT_CHECK} #${number} at an unknown commit`);
    err(e instanceof Error ? e.message : String(e));
    return 1;
  }
  for (const pull of pulls) {
    const result = await checkPull(repo, pull, openPulls, api, git);
    out(sessionLine(result));
    if (result.verdict.error) err(`  ${result.verdict.error}`);
  }
  return 0;
}

if ((import.meta as ImportMeta & { main?: boolean }).main) {
  const env = process.env;
  const argv = process.argv.slice(2);
  const out = (line: string): void => console.info(line);
  if (argv[0] === '--lint-body') {
    if (!env.GITHUB_EVENT_PATH) throw new Error('GITHUB_EVENT_PATH is required');
    process.exitCode = runBodyLint(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'), out);
  } else {
    process.exitCode = await runCli(argv, {
      repo: env.GITHUB_REPOSITORY || 'jaredglaser/homelab-manager',
      api: realApi(env.GH_TOKEN || env.GITHUB_TOKEN || undefined),
      git: realGit(join(import.meta.dir, '..')),
      out,
      err: (line) => console.error(line),
    });
  }
}

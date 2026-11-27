#!/usr/bin/env bun
// Usage: bun scripts/pr-ready.ts [<pr number>...]       (every open PR when none given)
//        bun scripts/pr-ready.ts --head-sha=<sha>       (open PRs whose head is <sha>)
//        bun scripts/pr-ready.ts --publish ...          (also write the Ready check run)
// Reads GH_TOKEN or GITHUB_TOKEN when set, and GITHUB_REPOSITORY (default
// jaredglaser/homelab-manager).

import { join } from 'node:path';

import { fetchWithRetry } from './fetch-retry';

export const CHECK_NAME = 'Ready';
export const COULD_NOT_CHECK = 'Could not check. Re-run this check.';

export type Conclusion = 'success' | 'failure' | 'neutral';
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
  appSlug: string;
  externalId: string;
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

export interface CheckRunWrite {
  conclusion: Conclusion;
  title: string;
  summary: string;
  externalId: string;
  detailsUrl?: string;
}

export interface GhApi {
  getPull(repo: string, number: number): Promise<GhPull>;
  listOpenPulls(repo: string): Promise<GhPull[]>;
  getBranchRules(repo: string, branch: string): Promise<unknown[]>;
  compare(repo: string, base: string, headSha: string): Promise<GhComparison>;
  listCheckRuns(repo: string, sha: string): Promise<GhCheckRun[]>;
  listStatuses(repo: string, sha: string): Promise<GhStatus[]>;
  createCheckRun(repo: string, headSha: string, run: CheckRunWrite): Promise<void>;
  updateCheckRun(repo: string, id: number, run: CheckRunWrite): Promise<void>;
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
  conclusion: Conclusion;
  line: string;
  reasons: string[];
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
      if (typeof c.context !== 'string' || c.context === CHECK_NAME) continue;
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

export function criteriaApply(pull: GhPull): boolean {
  return pull.author !== 'dependabot[bot]' && !pull.headRef.startsWith('release-please--');
}

export function stackedOn(pull: GhPull, openPulls: GhPull[]): number | null {
  const parent = openPulls.find((p) => p.number !== pull.number && p.headRef === pull.baseRef);
  return parent ? parent.number : null;
}

export function evaluate(facts: Facts): Verdict {
  const reasons: string[] = [];
  if (facts.draft) reasons.push('Not ready: this PR is a draft.');
  if (facts.stackedOn !== null) {
    reasons.push(`Not ready: stacked on #${facts.stackedOn}. Merge #${facts.stackedOn} first.`);
  }
  if (facts.conflictFiles > 0) {
    reasons.push(`Not ready: conflicts with ${facts.baseRef} in ${plural(facts.conflictFiles, 'file')}.`);
  }
  for (const c of facts.checks) if (c.state === 'failed') reasons.push(`Not ready: ${c.name} failed.`);
  for (const c of facts.checks) if (c.state === 'running') reasons.push(`Not ready: ${c.name} is still running.`);
  for (const c of facts.checks) {
    if (c.state === 'missing') reasons.push(`Not ready: ${c.name} has not run on this commit.`);
  }
  if (facts.acceptanceSha !== null && !acceptanceIsCurrent(facts.acceptanceSha, facts.headSha)) {
    const shown = RE_SHA.test(facts.acceptanceSha.toLowerCase()) ? facts.acceptanceSha.slice(0, 7) : facts.acceptanceSha;
    reasons.push(`Not ready: criteria were verified at ${shown} and the PR has moved since.`);
  }
  if (reasons.length > 0) return { conclusion: 'failure', line: reasons[0], reasons };
  const line =
    facts.behindBy > 0
      ? `Ready. ${plural(facts.behindBy, 'commit')} behind ${facts.baseRef}, no conflicts.`
      : 'Ready';
  return { conclusion: 'success', line, reasons: [] };
}

export function couldNotCheck(error: unknown): Verdict {
  return {
    conclusion: 'neutral',
    line: COULD_NOT_CHECK,
    reasons: [],
    error: error instanceof Error ? error.message : String(error),
  };
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

export function checkSummary(result: PrResult): string {
  const lines = [`${result.verdict.line}`, '', `Worked out at ${result.headSha.slice(0, 7)}.`];
  if (result.verdict.reasons.length > 1) {
    lines.push('', 'Everything that is not ready:', ...result.verdict.reasons.map((r) => `- ${r}`));
  }
  if (result.verdict.error) lines.push('', `GitHub did not answer: ${result.verdict.error}`);
  return lines.join('\n');
}

export async function publish(
  repo: string,
  result: PrResult,
  startedAtMs: number,
  api: GhApi,
  detailsUrl?: string,
): Promise<'created' | 'updated' | 'skipped'> {
  const runs = await api.listCheckRuns(repo, result.headSha);
  const existing = runs
    .filter((r) => r.name === CHECK_NAME && r.appSlug === 'github-actions')
    .reduce<GhCheckRun | null>((a, b) => (a === null || b.id > a.id ? b : a), null);
  if (existing && Number(existing.externalId) > startedAtMs) return 'skipped';
  const write: CheckRunWrite = {
    conclusion: result.verdict.conclusion,
    title: result.verdict.line,
    summary: checkSummary(result),
    externalId: String(startedAtMs),
    detailsUrl,
  };
  if (existing) {
    await api.updateCheckRun(repo, existing.id, write);
    return 'updated';
  }
  await api.createCheckRun(repo, result.headSha, write);
  return 'created';
}

export interface CliArgs {
  publish: boolean;
  headSha: string | null;
  numbers: number[];
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { publish: false, headSha: null, numbers: [] };
  for (const arg of argv) {
    if (arg === '--publish') {
      args.publish = true;
    } else if (arg.startsWith('--head-sha=')) {
      const sha = arg.slice('--head-sha='.length).toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`--head-sha needs a full commit SHA, got: ${sha}`);
      args.headSha = sha;
    } else if (/^#?\d+$/.test(arg)) {
      args.numbers.push(Number(arg.replace('#', '')));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

export function selectPulls(args: CliArgs, openPulls: GhPull[]): GhPull[] {
  if (args.headSha !== null) return openPulls.filter((p) => p.headSha === args.headSha);
  if (args.numbers.length === 0) return [...openPulls].sort((a, b) => b.number - a.number);
  return [];
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
  async function send(method: string, path: string, body: unknown): Promise<void> {
    const res = await fetchWithRetry(
      fetchImpl,
      base + path,
      { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      sleep,
    );
    if (!res.ok) throw new Error(`${method} ${path} failed: HTTP ${res.status}`);
  }
  function checkRunBody(run: CheckRunWrite): Record<string, unknown> {
    return {
      status: 'completed',
      conclusion: run.conclusion,
      external_id: run.externalId,
      ...(run.detailsUrl ? { details_url: run.detailsUrl } : {}),
      output: { title: run.title, summary: run.summary },
    };
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
          check_runs: Array<{
            id: number;
            name: string;
            status: string;
            conclusion: string | null;
            external_id: string | null;
            app: { id: number; slug: string } | null;
          }>;
        };
        out.push(
          ...batch.check_runs.map((r) => ({
            id: r.id,
            name: r.name,
            status: r.status,
            conclusion: r.conclusion,
            appId: r.app?.id ?? null,
            appSlug: r.app?.slug ?? '',
            externalId: r.external_id ?? '',
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
    async createCheckRun(repo, headSha, run) {
      await send('POST', `${repo}/check-runs`, { name: CHECK_NAME, head_sha: headSha, ...checkRunBody(run) });
    },
    async updateCheckRun(repo, id, run) {
      await send('PATCH', `${repo}/check-runs/${id}`, checkRunBody(run));
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
  startedAtMs: number;
  detailsUrl?: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const { repo, api, git, out, err } = deps;
  const args = parseArgs(argv);
  let openPulls: GhPull[];
  let pulls: GhPull[];
  try {
    openPulls = await api.listOpenPulls(repo);
    pulls = selectPulls(args, openPulls);
    for (const number of args.numbers) {
      pulls.push(openPulls.find((p) => p.number === number) ?? (await api.getPull(repo, number)));
    }
  } catch (e) {
    for (const number of args.numbers) out(`${COULD_NOT_CHECK} #${number} at an unknown commit`);
    err(e instanceof Error ? e.message : String(e));
    return 1;
  }
  for (const pull of pulls) {
    const result = await checkPull(repo, pull, openPulls, api, git);
    out(sessionLine(result));
    if (result.verdict.error) err(`  ${result.verdict.error}`);
    if (args.publish) out(`  check run ${await publish(repo, result, deps.startedAtMs, api, deps.detailsUrl)}`);
  }
  return 0;
}

if ((import.meta as ImportMeta & { main?: boolean }).main) {
  const env = process.env;
  const repo = env.GITHUB_REPOSITORY || 'jaredglaser/homelab-manager';
  process.exitCode = await runCli(process.argv.slice(2), {
    repo,
    api: realApi(env.GH_TOKEN || env.GITHUB_TOKEN || undefined),
    git: realGit(join(import.meta.dir, '..')),
    startedAtMs: Date.now(),
    detailsUrl: env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`
      : undefined,
    out: (line) => console.info(line),
    err: (line) => console.error(line),
  });
}

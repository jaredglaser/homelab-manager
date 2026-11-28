#!/usr/bin/env bun
// Usage: bun scripts/pr-body-lint.ts   (reads the pull_request event from $GITHUB_EVENT_PATH)

import { readFileSync } from 'node:fs';

interface PullRequestEvent {
  pull_request?: {
    body: string | null;
    user: { login: string } | null;
    head: { ref: string; sha: string };
  };
}

const RE_ACCEPTANCE = /^##[ \t]+Acceptance \(verified at ([^)\r\n]*)\)[ \t]*$/gm;
const RE_SHA = /^[0-9a-f]{7,40}$/;

export function acceptanceSha(body: string): string | null {
  const matches = [...body.matchAll(RE_ACCEPTANCE)];
  return matches.length > 0 ? matches.at(-1)![1].trim() : null;
}

export function acceptanceIsCurrent(verifiedAt: string, headSha: string): boolean {
  const sha = verifiedAt.toLowerCase();
  return RE_SHA.test(sha) && headSha.toLowerCase().startsWith(sha);
}

export function lintBody(event: unknown): { ok: boolean; message: string } {
  const pr = (event as PullRequestEvent | null)?.pull_request;
  if (!pr) return { ok: false, message: 'FAIL: the event payload has no pull_request.' };
  if (pr.user?.login === 'dependabot[bot]' || pr.head.ref.startsWith('release-please--')) {
    return { ok: true, message: 'OK: release-please and Dependabot PRs carry no Acceptance table.' };
  }
  const verifiedAt = acceptanceSha(pr.body ?? '');
  if (verifiedAt === null) return { ok: true, message: 'OK: the description has no Acceptance table.' };
  if (acceptanceIsCurrent(verifiedAt, pr.head.sha)) {
    return { ok: true, message: `OK: criteria were verified at the head commit ${pr.head.sha.slice(0, 7)}.` };
  }
  const shown = RE_SHA.test(verifiedAt.toLowerCase()) ? verifiedAt.slice(0, 7) : verifiedAt;
  return { ok: false, message: `Not ready: criteria were verified at ${shown} and the PR has moved since.` };
}

function escapeAnnotation(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export function runBodyLint(eventText: string, out: (line: string) => void): number {
  const result = lintBody(JSON.parse(eventText));
  if (!result.ok) out(`::error title=PR Body Lint::${escapeAnnotation(result.message)}`);
  out(result.message);
  return result.ok ? 0 : 1;
}

if ((import.meta as ImportMeta & { main?: boolean }).main) {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) throw new Error('GITHUB_EVENT_PATH is required');
  process.exitCode = runBodyLint(readFileSync(path, 'utf8'), (line) => console.info(line));
}

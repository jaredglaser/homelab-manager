#!/usr/bin/env bun
// Post or update the single "Version impact" comment on a pull request: what
// release-please will do to the release version when this PR merges. The squash
// commit subject is the PR title, so the title alone decides the classification.
// The PR body is consulted only for BREAKING CHANGE footers, matching
// release-please's parser. Bump rules mirror release-please's
// DefaultVersioningStrategy with bump-minor-pre-major and
// bump-patch-for-minor-pre-major (see release-please-config.json).
//
// Usage: bun scripts/pr-version-impact.ts           (needs GH_TOKEN, PR_NUMBER,
//                                                    PR_TITLE, GITHUB_REPOSITORY;
//                                                    PR_BODY optional)
//        bun scripts/pr-version-impact.ts --lint    (blocking PR Title Lint)

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Kind = 'none' | 'patch' | 'minor' | 'major';

export interface Classification {
  parsed: boolean;
  type: string;
  breaking: boolean;
}

export interface GhComment {
  id: number;
  login: string;
  body: string;
}

export interface GhApi {
  listIssueComments(repo: string, issue: number): Promise<GhComment[]>;
  createIssueComment(repo: string, issue: number, body: string): Promise<void>;
  updateIssueComment(repo: string, commentId: number, body: string): Promise<void>;
  listOpenPrTitles(repo: string): Promise<string[]>;
}

export interface RunInput {
  repo: string;
  prNumber: string;
  title: string;
  body: string;
  version: string;
}

export const MARKER = '<!-- version-impact -->';
const RE_TYPE = /^([A-Za-z]+)(\([^)]*\))?!?:/;
const RE_BREAKING = /^[A-Za-z]+(\([^)]*\))?!:/;
const RE_BREAKING_NOTE = /^BREAKING[ -]CHANGE:[ \t]*\S/m;
const KNOWN_TYPES = 'feat feature fix perf revert chore docs style refactor test build ci'.split(' ');
const CHANGELOG_TYPES = ['feat', 'feature', 'fix', 'perf', 'revert'];

export function classify(title: string, body: string): Classification {
  const m = RE_TYPE.exec(title);
  return {
    parsed: m !== null,
    type: m ? m[1] : '',
    breaking: RE_BREAKING.test(title) || RE_BREAKING_NOTE.test(body),
  };
}

export function contribKind(version: string, cls: Classification): Kind {
  if (!cls.parsed) return 'none';
  if (!cls.breaking && !CHANGELOG_TYPES.includes(cls.type)) return 'none';
  const preMajor = version.split('.')[0] === '0';
  if (cls.breaking) return preMajor ? 'minor' : 'major';
  if (preMajor) return 'patch';
  return cls.type === 'feat' || cls.type === 'feature' ? 'minor' : 'patch';
}

export function bumpVersion(version: string, kind: Kind): string {
  const [major, minor, patch] = version.split(/[.+-]/).map(Number);
  switch (kind) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    default:
      return version;
  }
}

export function changeKind(from: string, to: string): Kind {
  if (from === to) return 'none';
  const f = from.split('.');
  const t = to.split('.');
  if (f[0] !== t[0]) return 'major';
  if (f[1] !== t[1]) return 'minor';
  return 'patch';
}

export function kindRank(kind: Kind): number {
  switch (kind) {
    case 'none':
      return 0;
    case 'patch':
      return 1;
    case 'minor':
      return 2;
    case 'major':
      return 3;
  }
}

export function kindLabel(kind: Kind): string {
  switch (kind) {
    case 'none':
      return 'nothing (see warning below)';
    case 'patch':
      return 'a **patch** bump';
    case 'minor':
      return 'a **minor** bump';
    case 'major':
      return 'a **major** bump';
  }
}

function codeSpan(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
  const runs = [...escaped.matchAll(/`+/g)].map((m) => m[0].length);
  const fence = '`'.repeat((runs.length ? Math.max(...runs) : 0) + 1);
  const pad = escaped.startsWith('`') || escaped.endsWith('`') || fence.length > 1 ? ' ' : '';
  return fence + pad + escaped + pad + fence;
}

export function renderBody(title: string, body: string, version: string, kind: Kind, proposal: string): string {
  const cls = classify(title, body);
  const hidden = cls.parsed && !cls.breaking && !CHANGELOG_TYPES.includes(cls.type);
  const nextLine = hidden
    ? 'no release on its own'
    : kind === 'none'
      ? 'no contribution'
      : `\`v${version}\` -> \`v${bumpVersion(version, kind)}\``;
  const contributeLine = hidden
    ? 'nothing on its own (it ships with the next feat/fix/perf/revert release)'
    : kindLabel(kind);
  const classLine = cls.parsed ? `\`${cls.type}\`` : '**not a conventional commit**';
  let changelogLine: string;
  if (!cls.parsed) {
    changelogLine = 'missing';
  } else if (CHANGELOG_TYPES.includes(cls.type)) {
    changelogLine = 'shown';
  } else {
    changelogLine = `hidden (type \`${cls.type}\`)`;
  }
  let warnLines = '';
  if (!cls.parsed) {
    warnLines +=
      '> :warning: **This PR title is not a conventional commit.** Merged as-is, release-please will not bump the version and this work will be missing from the changelog. Rename the PR title to `type(scope): summary` before merge.\n';
  } else if (hidden && !KNOWN_TYPES.includes(cls.type)) {
    warnLines += '> :warning: **Unrecognized type `' + cls.type + '`.** It parses, but it has no changelog section and cuts no release on its own. Use one of: ' + KNOWN_TYPES.join(' ') + '.\n';
  } else if (hidden) {
    warnLines += '> :warning: **Type `' + cls.type + '` cuts no release on its own.** It is hidden from the changelog and ships only with the next feat/fix/perf/revert or breaking change.\n';
  }
  return `${MARKER}
## Version impact

| | |
|---|---|
| PR title | ${codeSpan(title)} |
| Conventional commit | ${classLine} |
| Breaking change | ${cls.breaking ? 'yes' : 'no'} |
| Current release | \`v${version}\` |
| This PR contributes | ${contributeLine} |
| Next release if this PR lands alone | ${nextLine} |
| Changelog entry | ${changelogLine} |
| Standing release PR | ${proposal} |

The release version is cut when the standing release-please PR merges. It batches everything merged since the last release and takes the strongest bump in the batch, so this row is this PR's contribution, not the final number. While the project is pre-1.0, \`feat\` and \`fix\` bump the patch and a breaking change bumps the minor. From 1.0.0 on, \`feat\` bumps the minor and a breaking change the major.

Breaking changes must show as \`type(scope)!: summary\` or a \`BREAKING CHANGE: ...\` line in the PR body. Prose such as "Breaking changes" is invisible to release-please.

${warnLines}
`;
}

export function lint(title: string, body: string): { ok: boolean; message: string } {
  const cls = classify(title, body);
  if (!cls.parsed) {
    return {
      ok: false,
      message:
        `FAIL: PR title does not parse as a conventional commit: ${title}\n` +
        "release-please drops it entirely: no version bump, no changelog entry. Expected 'type(scope): summary', e.g. 'fix: ...', 'feat(hosts): ...'.",
    };
  }
  if (!KNOWN_TYPES.includes(cls.type)) {
    return {
      ok: false,
      message: `FAIL: unknown commit type '${cls.type}'. Use one of: ${KNOWN_TYPES.join(' ')}`,
    };
  }
  const hidden = !cls.breaking && !CHANGELOG_TYPES.includes(cls.type);
  return {
    ok: true,
    message: hidden
      ? `OK: PR title classifies as '${cls.type}' and release-please will version it only together with a feat/fix/perf/revert or breaking change.`
      : `OK: PR title classifies as '${cls.type}'${cls.breaking ? ' (breaking)' : ''} and release-please will version it.`,
  };
}

export async function proposalLine(version: string, kind: Kind, api: GhApi, repo: string): Promise<string> {
  const prTitle = (await api.listOpenPrTitles(repo)).find((t) => t.startsWith('chore(main): release ')) ?? '';
  if (!prTitle) {
    return kind === 'none'
      ? 'none open yet. One opens when a feat/fix/perf/revert or breaking change lands'
      : `none open yet. The next run opens one at \`v${bumpVersion(version, kind)}\` for this bump`;
  }
  const proposed = prTitle.slice(prTitle.lastIndexOf(' ') + 1).replace(/[|`\r\n]/g, '');
  const proposalKind = changeKind(version, proposed);
  if (kind !== 'none' && kindRank(kind) > kindRank(proposalKind)) {
    return `\`v${proposed}\` open. This PR raises it to \`v${bumpVersion(version, kind)}\``;
  }
  return `\`v${proposed}\` open. This PR does not change it`;
}

export async function run(input: RunInput, api: GhApi): Promise<string> {
  const cls = classify(input.title, input.body);
  const kind = contribKind(input.version, cls);
  const proposal = await proposalLine(input.version, kind, api, input.repo);
  const newBody = renderBody(input.title, input.body, input.version, kind, proposal);
  const comments = await api.listIssueComments(input.repo, Number(input.prNumber));
  const existing = [...comments]
    .reverse()
    .find((c) => c.login === 'github-actions[bot]' && c.body.includes(MARKER));
  if (existing) {
    if (existing.body === newBody) {
      return 'Version impact comment unchanged; not editing.';
    }
    await api.updateIssueComment(input.repo, existing.id, newBody);
    return `Updated version impact comment ${existing.id}.`;
  }
  await api.createIssueComment(input.repo, Number(input.prNumber), newBody);
  return 'Posted version impact comment.';
}

function realApi(token: string): GhApi {
  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  async function getJson(url: string): Promise<unknown> {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
    return res.json();
  }
  async function send(method: string, url: string, body: string): Promise<void> {
    const res = await fetch(url, {
      method,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`${method} ${url} failed: HTTP ${res.status}`);
  }
  return {
    async listIssueComments(repo, issue) {
      const out: GhComment[] = [];
      for (let page = 1; ; page++) {
        const batch = (await getJson(
          `https://api.github.com/repos/${repo}/issues/${issue}/comments?per_page=100&page=${page}`,
        )) as Array<{ id: number; user: { login: string } | null; body: string | null }>;
        out.push(...batch.map((c) => ({ id: c.id, login: c.user?.login ?? '', body: c.body ?? '' })));
        if (batch.length < 100) break;
      }
      return out;
    },
    async createIssueComment(repo, issue, body) {
      await send('POST', `https://api.github.com/repos/${repo}/issues/${issue}/comments`, body);
    },
    async updateIssueComment(repo, commentId, body) {
      await send('PATCH', `https://api.github.com/repos/${repo}/issues/comments/${commentId}`, body);
    },
    async listOpenPrTitles(repo) {
      const out: string[] = [];
      for (let page = 1; ; page++) {
        const batch = (await getJson(
          `https://api.github.com/repos/${repo}/pulls?state=open&per_page=100&page=${page}`,
        )) as Array<{ title: string }>;
        out.push(...batch.map((p) => p.title));
        if (batch.length < 100) break;
      }
      return out;
    },
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const title = requireEnv('PR_TITLE');
  const body = process.env.PR_BODY ?? '';
  if (process.argv[2] === '--lint') {
    const result = lint(title, body);
    console.info(result.message);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const api = realApi(requireEnv('GH_TOKEN'));
  const version = readFileSync(join(import.meta.dir, '..', 'version.txt'), 'utf8').replace(/\s/g, '');
  const message = await run(
    {
      repo: requireEnv('GITHUB_REPOSITORY'),
      prNumber: requireEnv('PR_NUMBER'),
      title,
      body,
      version,
    },
    api,
  );
  console.info(message);
}

if ((import.meta as ImportMeta & { main?: boolean }).main) {
  await main();
}

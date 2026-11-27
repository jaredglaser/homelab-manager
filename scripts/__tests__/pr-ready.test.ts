import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acceptanceIsCurrent,
  acceptanceSha,
  checkPull,
  checkState,
  COULD_NOT_CHECK,
  couldNotCheck,
  criteriaApply,
  evaluate,
  lintBody,
  parseNumbers,
  realApi,
  realGit,
  reasons,
  requiredChecksFromRules,
  runBodyLint,
  runCli,
  sessionLine,
  staleCriteria,
  type Facts,
  type GhApi,
  type GhCheckRun,
  type GhPull,
  type GitApi,
} from '../pr-ready';

const REPO = 'owner/repo';
const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';
const BUILD = 'Build, Test & License Check';
const LINT = 'PR Title Lint';

function rules(contexts: string[]): unknown[] {
  return [
    { type: 'required_signatures' },
    {
      type: 'required_status_checks',
      parameters: { required_status_checks: contexts.map((context) => ({ context, integration_id: 15368 })) },
    },
  ];
}

function run(name: string, status: string, conclusion: string | null, id = 1, appId: number | null = 15368): GhCheckRun {
  return { id, name, status, conclusion, appId };
}

function pull(overrides: Partial<GhPull> = {}): GhPull {
  return {
    number: 700,
    draft: false,
    body: '',
    author: 'someone',
    headRef: 'feature',
    headSha: HEAD,
    baseRef: 'main',
    ...overrides,
  };
}

function facts(overrides: Partial<Facts> = {}): Facts {
  return {
    draft: false,
    baseRef: 'main',
    headSha: HEAD,
    stackedOn: null,
    conflictFiles: 0,
    behindBy: 0,
    checks: [
      { name: BUILD, state: 'passed' },
      { name: LINT, state: 'passed' },
    ],
    acceptanceSha: null,
    ...overrides,
  };
}

interface FakeOpts {
  contexts?: string[];
  runs?: GhCheckRun[];
  behindBy?: number;
  conflicts?: number;
  fail?: keyof GhApi | 'fetchCommits' | 'conflictingFiles';
}

function fakes(opts: FakeOpts = {}): { api: GhApi; git: GitApi; rulesFor: string[] } {
  const rulesFor: string[] = [];
  const guard = (name: string): void => {
    if (opts.fail === name) throw new Error(`GET ${name} failed: HTTP 403`);
  };
  const api: GhApi = {
    getPull: async (_repo, number) => {
      guard('getPull');
      return pull({ number });
    },
    listOpenPulls: async () => {
      guard('listOpenPulls');
      return [pull()];
    },
    getBranchRules: async (_repo, branch) => {
      guard('getBranchRules');
      rulesFor.push(branch);
      return rules(opts.contexts ?? [BUILD, LINT]);
    },
    compare: async () => {
      guard('compare');
      return { baseSha: 'b'.repeat(40), mergeBaseSha: 'c'.repeat(40), behindBy: opts.behindBy ?? 0 };
    },
    listCheckRuns: async () => {
      guard('listCheckRuns');
      return opts.runs ?? [run(BUILD, 'completed', 'success', 1), run(LINT, 'completed', 'success', 2)];
    },
    listStatuses: async () => {
      guard('listStatuses');
      return [];
    },
  };
  const git: GitApi = {
    fetchCommits: async () => {
      guard('fetchCommits');
    },
    conflictingFiles: async () => {
      guard('conflictingFiles');
      return opts.conflicts ?? 0;
    },
  };
  return { api, git, rulesFor };
}

describe('the Ready line, word for word', () => {
  test('w1: everything holds and the branch is up to date', () => {
    expect(evaluate(facts())).toEqual({ line: 'Ready' });
  });

  test('w2: behind main with no conflicts states the count (AC3)', () => {
    expect(evaluate(facts({ behindBy: 3 })).line).toBe('Ready. 3 commits behind main, no conflicts.');
    expect(evaluate(facts({ behindBy: 1 })).line).toBe('Ready. 1 commit behind main, no conflicts.');
  });

  test('w3: a required check is still running', () => {
    expect(evaluate(facts({ checks: [{ name: BUILD, state: 'running' }] })).line).toBe(
      'Not ready: Build, Test & License Check is still running.',
    );
  });

  test('w4: a required check failed', () => {
    expect(evaluate(facts({ checks: [{ name: BUILD, state: 'failed' }] })).line).toBe(
      'Not ready: Build, Test & License Check failed.',
    );
  });

  test('w5: a required check has no result at this commit', () => {
    expect(evaluate(facts({ checks: [{ name: LINT, state: 'missing' }] })).line).toBe(
      'Not ready: PR Title Lint has not run on this commit.',
    );
  });

  test('w6: the PR conflicts with current main', () => {
    expect(evaluate(facts({ conflictFiles: 2, behindBy: 4 })).line).toBe('Not ready: conflicts with main in 2 files.');
    expect(evaluate(facts({ conflictFiles: 1 })).line).toBe('Not ready: conflicts with main in 1 file.');
  });

  test('w7: the base is another open PR (AC4)', () => {
    expect(evaluate(facts({ stackedOn: 676 })).line).toBe('Not ready: stacked on #676. Merge #676 first.');
  });

  test('w8: the Acceptance table is at an older commit', () => {
    expect(evaluate(facts({ acceptanceSha: '1a2b3c4d5e' })).line).toBe(
      'Not ready: criteria were verified at 1a2b3c4 and the PR has moved since.',
    );
  });

  test('w9: a draft', () => {
    expect(evaluate(facts({ draft: true })).line).toBe('Not ready: this PR is a draft.');
  });

  test('w11: could not check is never Ready (AC8)', () => {
    expect(couldNotCheck(new Error('GET x failed: HTTP 502'))).toEqual({
      line: 'Could not check. Run it again.',
      error: 'GET x failed: HTTP 502',
    });
    expect(couldNotCheck('boom').error).toBe('boom');
  });

  test('w12: the session line is the PR line plus the PR number and commit', () => {
    expect(sessionLine({ number: 693, headSha: HEAD, verdict: evaluate(facts({ behindBy: 3 })) })).toBe(
      'Ready. 3 commits behind main, no conflicts. #693 at abcdef1',
    );
  });

  test('the first reason is the line', () => {
    const f = facts({
      draft: true,
      stackedOn: 676,
      conflictFiles: 2,
      acceptanceSha: '1a2b3c4',
      checks: [
        { name: BUILD, state: 'failed' },
        { name: LINT, state: 'running' },
        { name: 'Other', state: 'missing' },
      ],
    });
    expect(reasons(f)).toEqual([
      'Not ready: this PR is a draft.',
      'Not ready: stacked on #676. Merge #676 first.',
      'Not ready: conflicts with main in 2 files.',
      'Not ready: Build, Test & License Check failed.',
      'Not ready: PR Title Lint is still running.',
      'Not ready: Other has not run on this commit.',
      'Not ready: criteria were verified at 1a2b3c4 and the PR has moved since.',
    ]);
    expect(evaluate(f).line).toBe('Not ready: this PR is a draft.');
  });
});

describe('required checks come from the ruleset (AC11)', () => {
  test('names, order and integration id are read from the rules', () => {
    expect(requiredChecksFromRules(rules([BUILD, LINT]))).toEqual([
      { context: BUILD, integrationId: 15368 },
      { context: LINT, integrationId: 15368 },
    ]);
  });

  test('a renamed or added check is followed and duplicates are dropped', () => {
    const extra = [
      ...rules(['Build & Test', LINT]),
      {
        type: 'required_status_checks',
        parameters: { required_status_checks: [{ context: 'Lint' }, { context: LINT }, { nope: 1 }] },
      },
      { type: 'required_status_checks', parameters: {} },
    ];
    expect(requiredChecksFromRules(extra)).toEqual([
      { context: 'Build & Test', integrationId: 15368 },
      { context: LINT, integrationId: 15368 },
      { context: 'Lint', integrationId: null },
    ]);
  });

  test('a renamed check in the ruleset changes the verdict with no code change', async () => {
    const { api, git } = fakes({ contexts: ['Build & Test', LINT] });
    const r = await checkPull(REPO, pull(), [pull()], api, git);
    expect(r.verdict.line).toBe('Not ready: Build & Test has not run on this commit.');
  });
});

describe('checkState', () => {
  const build = { context: BUILD, integrationId: 15368 };

  test('the newest run of a check wins', () => {
    expect(checkState(build, [run(BUILD, 'completed', 'cancelled', 1), run(BUILD, 'completed', 'success', 2)], [])).toBe('passed');
    expect(checkState(build, [run(BUILD, 'completed', 'success', 2), run(BUILD, 'in_progress', null, 3)], [])).toBe('running');
    expect(checkState(build, [run(BUILD, 'queued', null, 3), run(BUILD, 'completed', 'success', 2)], [])).toBe('running');
  });

  test('conclusions map to passed or failed', () => {
    for (const c of ['success', 'neutral', 'skipped']) expect(checkState(build, [run(BUILD, 'completed', c)], [])).toBe('passed');
    for (const c of ['failure', 'cancelled', 'timed_out', 'action_required', 'stale', null]) {
      expect(checkState(build, [run(BUILD, 'completed', c)], [])).toBe('failed');
    }
  });

  test('a run from another app does not count', () => {
    expect(checkState(build, [run(BUILD, 'completed', 'success', 1, 999)], [])).toBe('missing');
    expect(checkState({ context: BUILD, integrationId: null }, [run(BUILD, 'completed', 'success', 1, 999)], [])).toBe('passed');
  });

  test('commit statuses are read when there is no check run', () => {
    expect(checkState(build, [], [{ context: BUILD, state: 'success' }])).toBe('passed');
    expect(checkState(build, [], [{ context: BUILD, state: 'pending' }])).toBe('running');
    expect(checkState(build, [], [{ context: BUILD, state: 'error' }])).toBe('failed');
    expect(checkState(build, [], [{ context: 'other', state: 'success' }])).toBe('missing');
  });
});

describe('Acceptance table', () => {
  test('reads the SHA from the last heading', () => {
    expect(acceptanceSha('intro\n## Acceptance (verified at 1a2b3c4)\n| ID |\n')).toBe('1a2b3c4');
    expect(acceptanceSha('## Acceptance (verified at aaaaaaa)\n\n## Acceptance (verified at bbbbbbb)\n')).toBe('bbbbbbb');
    expect(acceptanceSha('## Acceptance\n| ID |')).toBeNull();
    expect(acceptanceSha('')).toBeNull();
  });

  test('a short or full SHA that prefixes the head is current', () => {
    expect(acceptanceIsCurrent('abcdef1', HEAD)).toBe(true);
    expect(acceptanceIsCurrent(HEAD.toUpperCase(), HEAD)).toBe(true);
    expect(acceptanceIsCurrent('abcdef2', HEAD)).toBe(false);
    expect(acceptanceIsCurrent('abc', HEAD)).toBe(false);
    expect(acceptanceIsCurrent('<head SHA>', HEAD)).toBe(false);
  });

  test('staleCriteria quotes a short SHA, or a non-SHA value as written', () => {
    expect(staleCriteria(null, HEAD)).toBeNull();
    expect(staleCriteria('abcdef1', HEAD)).toBeNull();
    expect(staleCriteria('1a2b3c4d5e6f', HEAD)).toBe('Not ready: criteria were verified at 1a2b3c4 and the PR has moved since.');
    expect(staleCriteria('<head SHA>', HEAD)).toBe(
      'Not ready: criteria were verified at <head SHA> and the PR has moved since.',
    );
  });

  test('a table at the head is ready', async () => {
    const { api, git } = fakes();
    const r = await checkPull(REPO, pull({ body: '## Acceptance (verified at abcdef1)\n' }), [], api, git);
    expect(r.verdict.line).toBe('Ready');
  });

  test('a PR with no Acceptance table is not failed for it (AC6)', async () => {
    const { api, git } = fakes();
    const r = await checkPull(REPO, pull({ body: 'fix: a small fix\n\nNo criteria here.' }), [], api, git);
    expect(r.verdict).toEqual({ line: 'Ready' });
  });

  test('release and Dependabot PRs are not judged on a table', async () => {
    const stale = '## Acceptance (verified at 1111111)\n';
    expect(criteriaApply(pull({ author: 'dependabot[bot]' }))).toBe(false);
    expect(criteriaApply(pull({ headRef: 'release-please--branches--main--components--homelab-manager' }))).toBe(false);
    expect(criteriaApply(pull())).toBe(true);
    const { api, git } = fakes();
    expect((await checkPull(REPO, pull({ author: 'dependabot[bot]', body: stale }), [], api, git)).verdict.line).toBe('Ready');
    expect((await checkPull(REPO, pull({ body: stale }), [], api, git)).verdict.line).toBe(
      'Not ready: criteria were verified at 1111111 and the PR has moved since.',
    );
  });
});

describe('checkPull', () => {
  test('a base that is another open PR names the parent and reads that branch rules (AC4)', async () => {
    const parent = pull({ number: 676, headRef: 'parent-branch' });
    const child = pull({ number: 677, baseRef: 'parent-branch' });
    const { api, git, rulesFor } = fakes();
    const r = await checkPull(REPO, child, [parent, child], api, git);
    expect(r.verdict.line).toBe('Not ready: stacked on #676. Merge #676 first.');
    expect(rulesFor).toEqual(['parent-branch']);
  });

  test('behind and conflicting is red with the file count', async () => {
    const { api, git } = fakes({ behindBy: 5, conflicts: 2 });
    expect((await checkPull(REPO, pull(), [], api, git)).verdict.line).toBe('Not ready: conflicts with main in 2 files.');
  });

  test('a running check at the head is not ready', async () => {
    const { api, git } = fakes({ runs: [run(BUILD, 'in_progress', null, 1), run(LINT, 'completed', 'success', 2)] });
    const r = await checkPull(REPO, pull(), [], api, git);
    expect(r.verdict.line).toBe('Not ready: Build, Test & License Check is still running.');
  });

  test.each(['getBranchRules', 'listCheckRuns', 'listStatuses', 'compare', 'fetchCommits', 'conflictingFiles'] as const)(
    'GitHub or git failing at %s reads "Could not check" (AC8)',
    async (fail) => {
      const { api, git } = fakes({ fail });
      const r = await checkPull(REPO, pull(), [], api, git);
      expect(r.verdict.line).toBe(COULD_NOT_CHECK);
      expect(r.headSha).toBe(HEAD);
    },
  );
});

describe('PR Body Lint', () => {
  function event(body: string | null, overrides: { sha?: string; ref?: string; login?: string } = {}): unknown {
    return {
      pull_request: {
        number: 7,
        body,
        user: { login: overrides.login ?? 'someone' },
        head: { ref: overrides.ref ?? 'feature', sha: overrides.sha ?? HEAD },
        base: { ref: 'main' },
      },
    };
  }

  test('no Acceptance table passes', () => {
    expect(lintBody(event('A small fix.'))).toEqual({ ok: true, message: 'OK: the description has no Acceptance table.' });
    expect(lintBody(event(null)).ok).toBe(true);
  });

  test('a table at the head passes, short or full SHA', () => {
    expect(lintBody(event('## Acceptance (verified at abcdef1)\n'))).toEqual({
      ok: true,
      message: 'OK: criteria were verified at the head commit abcdef1.',
    });
    expect(lintBody(event(`## Acceptance (verified at ${HEAD})\n`)).ok).toBe(true);
  });

  test('a stale table fails with message w8 and an error annotation', () => {
    expect(lintBody(event('## Acceptance (verified at 1a2b3c4)\n'))).toEqual({
      ok: false,
      message: 'Not ready: criteria were verified at 1a2b3c4 and the PR has moved since.',
    });
    const out: string[] = [];
    expect(runBodyLint(JSON.stringify(event('## Acceptance (verified at 1a2b3c4)\n')), (l) => out.push(l))).toBe(1);
    expect(out).toEqual([
      '::error title=PR Body Lint::Not ready: criteria were verified at 1a2b3c4 and the PR has moved since.',
      'Not ready: criteria were verified at 1a2b3c4 and the PR has moved since.',
    ]);
  });

  test('the annotation escapes workflow command characters', () => {
    const out: string[] = [];
    runBodyLint(JSON.stringify(event('## Acceptance (verified at 100% done)\n')), (l) => out.push(l));
    expect(out[0]).toBe('::error title=PR Body Lint::Not ready: criteria were verified at 100%25 done and the PR has moved since.');
  });

  test('release-please and Dependabot heads pass even with a stale table', () => {
    const stale = '## Acceptance (verified at 1a2b3c4)\n';
    expect(lintBody(event(stale, { ref: 'release-please--branches--main' })).ok).toBe(true);
    expect(lintBody(event(stale, { login: 'dependabot[bot]' }))).toEqual({
      ok: true,
      message: 'OK: release-please and Dependabot PRs carry no Acceptance table.',
    });
  });

  test('a passing run prints its message and exits 0', () => {
    const out: string[] = [];
    expect(runBodyLint(JSON.stringify(event('')), (l) => out.push(l))).toBe(0);
    expect(out).toEqual(['OK: the description has no Acceptance table.']);
  });

  test('a payload with no pull_request fails', () => {
    expect(lintBody({})).toEqual({ ok: false, message: 'FAIL: the event payload has no pull_request.' });
    expect(lintBody(null).ok).toBe(false);
  });
});

describe('runCli', () => {
  function deps(f: ReturnType<typeof fakes>): { out: string[]; err: string[]; d: Parameters<typeof runCli>[1] } {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, d: { repo: REPO, api: f.api, git: f.git, out: (l) => out.push(l), err: (l) => err.push(l) } };
  }

  test('parseNumbers', () => {
    expect(parseNumbers(['694', '#693'])).toEqual([694, 693]);
    expect(() => parseNumbers(['--publish'])).toThrow('Unknown argument: --publish');
  });

  test('prints one session line per PR, every open PR when none is named', async () => {
    const { out, d } = deps(fakes());
    expect(await runCli(['700', '701'], d)).toBe(0);
    expect(out).toEqual(['Ready #700 at abcdef1', 'Ready #701 at abcdef1']);
    const all = deps(fakes());
    expect(await runCli([], all.d)).toBe(0);
    expect(all.out).toEqual(['Ready #700 at abcdef1']);
  });

  test('prints the error under a could-not-check line', async () => {
    const { out, err, d } = deps(fakes({ fail: 'compare' }));
    expect(await runCli([], d)).toBe(0);
    expect(out).toEqual(['Could not check. Run it again. #700 at abcdef1']);
    expect(err).toEqual(['  GET compare failed: HTTP 403']);
  });

  test('exits 1 with "Could not check" when the PR list cannot be read', async () => {
    const { out, err, d } = deps(fakes({ fail: 'listOpenPulls' }));
    expect(await runCli(['694'], d)).toBe(1);
    expect(out).toEqual(['Could not check. Run it again. #694 at an unknown commit']);
    expect(err).toEqual(['GET listOpenPulls failed: HTTP 403']);
  });
});

describe('realApi', () => {
  function fakeFetch(routes: Record<string, unknown>, status = 200): {
    calls: Array<{ url: string; init: RequestInit }>;
    impl: (url: string, init: RequestInit) => Promise<Response>;
  } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    return {
      calls,
      impl: async (url, init) => {
        calls.push({ url, init });
        const path = url.replace('https://api.github.com/repos/', '');
        const key = Object.keys(routes).find((k) => path.startsWith(k));
        return new Response(JSON.stringify(key ? routes[key] : {}), { status });
      },
    };
  }
  const rawPull = (number: number) => ({
    number,
    draft: true,
    body: null,
    user: null,
    head: { ref: 'h', sha: HEAD },
    base: { ref: 'main' },
  });

  test('reads pulls, rules, comparison, check runs and statuses', async () => {
    const f = fakeFetch({
      [`${REPO}/pulls/7`]: rawPull(7),
      [`${REPO}/pulls?state=open`]: [rawPull(1)],
      [`${REPO}/rules/branches/bot%2Fx`]: rules([BUILD]),
      [`${REPO}/compare/main...${HEAD}`]: { behind_by: 3, base_commit: { sha: 'b' }, merge_base_commit: { sha: 'm' } },
      [`${REPO}/commits/${HEAD}/check-runs`]: {
        check_runs: [{ id: 4, name: BUILD, status: 'completed', conclusion: 'success', app: null }],
      },
      [`${REPO}/commits/${HEAD}/status`]: { statuses: [{ context: 'c', state: 'success', extra: 1 }] },
    });
    const api = realApi('tok', f.impl);
    expect(await api.getPull(REPO, 7)).toEqual({
      number: 7,
      draft: true,
      body: '',
      author: '',
      headRef: 'h',
      headSha: HEAD,
      baseRef: 'main',
    });
    expect((await api.listOpenPulls(REPO)).map((p) => p.number)).toEqual([1]);
    expect(await api.getBranchRules(REPO, 'bot/x')).toEqual(rules([BUILD]));
    expect(await api.compare(REPO, 'main', HEAD)).toEqual({ baseSha: 'b', mergeBaseSha: 'm', behindBy: 3 });
    expect(await api.listCheckRuns(REPO, HEAD)).toEqual([
      { id: 4, name: BUILD, status: 'completed', conclusion: 'success', appId: null },
    ]);
    expect(await api.listStatuses(REPO, HEAD)).toEqual([{ context: 'c', state: 'success' }]);
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  test('pages through more than 100 open pulls and check runs', async () => {
    let pullPage = 0;
    let runPage = 0;
    const impl = async (url: string): Promise<Response> => {
      if (url.includes('/pulls?')) {
        pullPage++;
        return Response.json(Array.from({ length: pullPage === 1 ? 100 : 1 }, (_, i) => rawPull(pullPage * 1000 + i)));
      }
      runPage++;
      const r = { id: runPage, name: 'n', status: 'queued', conclusion: null, app: { id: 1 } };
      return Response.json({ check_runs: Array.from({ length: runPage === 1 ? 100 : 0 }, () => r) });
    };
    const api = realApi(undefined, impl);
    expect(await api.listOpenPulls(REPO)).toHaveLength(101);
    expect(await api.listCheckRuns(REPO, HEAD)).toHaveLength(100);
    expect(runPage).toBe(2);
  });

  test('a refused or rate-limited request throws so the line reads "Could not check"', async () => {
    const refused = fakeFetch({}, 403);
    await expect(realApi(undefined, refused.impl).getPull(REPO, 1)).rejects.toThrow(`GET ${REPO}/pulls/1 failed: HTTP 403`);
    expect((refused.calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
    const limited = realApi('t', fakeFetch({}, 429).impl, async () => {});
    const { git } = fakes();
    const r = await checkPull(REPO, pull(), [], limited, git);
    expect(r.verdict).toEqual({
      line: COULD_NOT_CHECK,
      error: `GET ${REPO}/rules/branches/main?per_page=100 failed: HTTP 429`,
    });
  });
});

describe('realGit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-ready-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  function sh(...args: string[]): string {
    const p = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd: dir,
    });
    if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    return p.stdout.toString().trim();
  }
  function commit(files: Record<string, string>, message: string): string {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    sh('add', '.');
    sh('commit', '-q', '-m', message);
    return sh('rev-parse', 'HEAD');
  }

  sh('init', '-q', '-b', 'main');
  const root = commit({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' }, 'root');
  const main = commit({ 'a.txt': 'main a\n', 'b.txt': 'main b\n' }, 'main');
  sh('checkout', '-q', '-b', 'feature', root);
  const conflicting = commit({ 'a.txt': 'feature a\n', 'b.txt': 'feature b\n', 'c.txt': 'feature c\n' }, 'feature');
  sh('checkout', '-q', '-b', 'clean', root);
  const clean = commit({ 'c.txt': 'clean c\n' }, 'clean');

  test('counts the files that conflict', async () => {
    const git = realGit(dir);
    expect(await git.conflictingFiles(root, main, conflicting)).toBe(2);
    expect(await git.conflictingFiles(root, main, clean)).toBe(0);
  });

  test('a git failure throws', async () => {
    const git = realGit(dir);
    await expect(git.conflictingFiles(root, main, 'f'.repeat(40))).rejects.toThrow('git merge-tree failed');
    await git.fetchCommits([root, main]);
    await expect(git.fetchCommits(['f'.repeat(40)])).rejects.toThrow('git fetch failed');
  });
});

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acceptanceIsCurrent,
  acceptanceSha,
  checkPull,
  checkState,
  checkSummary,
  COULD_NOT_CHECK,
  couldNotCheck,
  criteriaApply,
  evaluate,
  parseArgs,
  publish,
  realApi,
  realGit,
  requiredChecksFromRules,
  runCli,
  selectPulls,
  sessionLine,
  type CheckRunWrite,
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

function run(name: string, status: string, conclusion: string | null, id = 1, extra: Partial<GhCheckRun> = {}): GhCheckRun {
  return { id, name, status, conclusion, appId: 15368, appSlug: 'github-actions', externalId: '', ...extra };
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

function fakes(opts: FakeOpts = {}): {
  api: GhApi;
  git: GitApi;
  created: Array<{ sha: string; run: CheckRunWrite }>;
  updated: Array<{ id: number; run: CheckRunWrite }>;
  rulesFor: string[];
} {
  const created: Array<{ sha: string; run: CheckRunWrite }> = [];
  const updated: Array<{ id: number; run: CheckRunWrite }> = [];
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
    createCheckRun: async (_repo, sha, r) => {
      created.push({ sha, run: r });
    },
    updateCheckRun: async (_repo, id, r) => {
      updated.push({ id, run: r });
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
  return { api, git, created, updated, rulesFor };
}

describe('the Ready line, word for word', () => {
  test('w1: everything holds and the branch is up to date', () => {
    expect(evaluate(facts())).toEqual({ conclusion: 'success', line: 'Ready', reasons: [] });
  });

  test('w2: behind main with no conflicts is green and states the count (AC3)', () => {
    const v = evaluate(facts({ behindBy: 3 }));
    expect(v.conclusion).toBe('success');
    expect(v.line).toBe('Ready. 3 commits behind main, no conflicts.');
    expect(evaluate(facts({ behindBy: 1 })).line).toBe('Ready. 1 commit behind main, no conflicts.');
  });

  test('w3: a required check is still running', () => {
    const v = evaluate(facts({ checks: [{ name: BUILD, state: 'running' }] }));
    expect(v.conclusion).toBe('failure');
    expect(v.line).toBe('Not ready: Build, Test & License Check is still running.');
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
    const v = evaluate(facts({ conflictFiles: 2, behindBy: 4 }));
    expect(v.conclusion).toBe('failure');
    expect(v.line).toBe('Not ready: conflicts with main in 2 files.');
    expect(evaluate(facts({ conflictFiles: 1 })).line).toBe('Not ready: conflicts with main in 1 file.');
  });

  test('w7: the base is another open PR (AC4)', () => {
    const v = evaluate(facts({ stackedOn: 676 }));
    expect(v.conclusion).toBe('failure');
    expect(v.line).toBe('Not ready: stacked on #676. Merge #676 first.');
  });

  test('w8: the Acceptance table is at an older commit', () => {
    const v = evaluate(facts({ acceptanceSha: '1a2b3c4d5e' }));
    expect(v.conclusion).toBe('failure');
    expect(v.line).toBe('Not ready: criteria were verified at 1a2b3c4 and the PR has moved since.');
  });

  test('w9: a draft is red', () => {
    const v = evaluate(facts({ draft: true }));
    expect(v.conclusion).toBe('failure');
    expect(v.line).toBe('Not ready: this PR is a draft.');
  });

  test('w11: could not check is neutral, never success (AC8)', () => {
    const v = couldNotCheck(new Error('GET x failed: HTTP 502'));
    expect(v).toEqual({ conclusion: 'neutral', line: 'Could not check. Re-run this check.', reasons: [], error: 'GET x failed: HTTP 502' });
    expect(couldNotCheck('boom').error).toBe('boom');
  });

  test('w12: the session line is the PR line plus the PR number and commit', () => {
    expect(sessionLine({ number: 693, headSha: HEAD, verdict: evaluate(facts({ behindBy: 3 })) })).toBe(
      'Ready. 3 commits behind main, no conflicts. #693 at abcdef1',
    );
  });

  test('the first reason is the line and every reason is in the summary', () => {
    const v = evaluate(
      facts({
        draft: true,
        stackedOn: 676,
        conflictFiles: 2,
        acceptanceSha: '1a2b3c4',
        checks: [
          { name: BUILD, state: 'failed' },
          { name: LINT, state: 'running' },
          { name: 'Other', state: 'missing' },
        ],
      }),
    );
    expect(v.reasons).toEqual([
      'Not ready: this PR is a draft.',
      'Not ready: stacked on #676. Merge #676 first.',
      'Not ready: conflicts with main in 2 files.',
      'Not ready: Build, Test & License Check failed.',
      'Not ready: PR Title Lint is still running.',
      'Not ready: Other has not run on this commit.',
      'Not ready: criteria were verified at 1a2b3c4 and the PR has moved since.',
    ]);
    const summary = checkSummary({ number: 1, headSha: HEAD, verdict: v });
    expect(summary).toStartWith('Not ready: this PR is a draft.\n\nWorked out at abcdef1.');
    expect(summary).toContain('- Not ready: Other has not run on this commit.');
    expect(checkSummary({ number: 1, headSha: HEAD, verdict: couldNotCheck(new Error('HTTP 502')) })).toContain(
      'GitHub did not answer: HTTP 502',
    );
  });
});

describe('required checks come from the ruleset (AC11)', () => {
  test('names, order and integration id are read from the rules', () => {
    expect(requiredChecksFromRules(rules([BUILD, LINT]))).toEqual([
      { context: BUILD, integrationId: 15368 },
      { context: LINT, integrationId: 15368 },
    ]);
  });

  test('a renamed or added check is followed and duplicates or Ready itself are dropped', () => {
    const extra = [
      ...rules(['Build & Test', LINT]),
      {
        type: 'required_status_checks',
        parameters: { required_status_checks: [{ context: 'Lint' }, { context: LINT }, { context: 'Ready' }, { nope: 1 }] },
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
    expect(checkState(build, [run(BUILD, 'completed', 'success', 1, { appId: 999 })], [])).toBe('missing');
    expect(checkState({ context: BUILD, integrationId: null }, [run(BUILD, 'completed', 'success', 1, { appId: 999 })], [])).toBe(
      'passed',
    );
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

  test('a non-SHA value is quoted as written', () => {
    expect(evaluate(facts({ acceptanceSha: '<head SHA>' })).line).toBe(
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
    expect(r.verdict).toEqual({ conclusion: 'success', line: 'Ready', reasons: [] });
  });

  test('release and Dependabot PRs get only the four facts (AC7)', async () => {
    const stale = '## Acceptance (verified at 1111111)\n';
    expect(criteriaApply(pull({ author: 'dependabot[bot]' }))).toBe(false);
    expect(criteriaApply(pull({ headRef: 'release-please--branches--main--components--homelab-manager' }))).toBe(false);
    expect(criteriaApply(pull())).toBe(true);
    const { api, git } = fakes();
    expect((await checkPull(REPO, pull({ author: 'dependabot[bot]', body: stale }), [], api, git)).verdict.line).toBe('Ready');
    expect((await checkPull(REPO, pull({ body: stale }), [], api, git)).verdict.line).toBe(
      'Not ready: criteria were verified at 1111111 and the PR has moved since.',
    );
    const failing = fakes({ runs: [run(BUILD, 'completed', 'failure', 1), run(LINT, 'completed', 'success', 2)] });
    expect((await checkPull(REPO, pull({ author: 'dependabot[bot]' }), [], failing.api, failing.git)).verdict.line).toBe(
      'Not ready: Build, Test & License Check failed.',
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

  test('once the parent merges and the child points at main it is worked out again (AC5 logic)', async () => {
    const child = pull({ number: 677, baseRef: 'main' });
    const { api, git } = fakes({ behindBy: 1 });
    const r = await checkPull(REPO, child, [child], api, git);
    expect(r.verdict.line).toBe('Ready. 1 commit behind main, no conflicts.');
  });

  test('behind and conflicting is red with the file count', async () => {
    const { api, git } = fakes({ behindBy: 5, conflicts: 2 });
    expect((await checkPull(REPO, pull(), [], api, git)).verdict.line).toBe('Not ready: conflicts with main in 2 files.');
  });

  test('a running check at the head is red (AC1 logic)', async () => {
    const { api, git } = fakes({ runs: [run(BUILD, 'in_progress', null, 1), run(LINT, 'completed', 'success', 2)] });
    const r = await checkPull(REPO, pull(), [], api, git);
    expect(r.verdict.conclusion).toBe('failure');
    expect(r.verdict.line).toBe('Not ready: Build, Test & License Check is still running.');
  });

  test.each(['getBranchRules', 'listCheckRuns', 'listStatuses', 'compare', 'fetchCommits', 'conflictingFiles'] as const)(
    'GitHub or git failing at %s reads "Could not check" and is never green (AC8)',
    async (fail) => {
      const { api, git } = fakes({ fail });
      const r = await checkPull(REPO, pull(), [], api, git);
      expect(r.verdict.conclusion).toBe('neutral');
      expect(r.verdict.line).toBe(COULD_NOT_CHECK);
      expect(r.headSha).toBe(HEAD);
    },
  );
});

describe('publish', () => {
  const result = { number: 700, headSha: HEAD, verdict: evaluate(facts()) };

  test('creates the Ready check run at the head commit', async () => {
    const { api, created } = fakes({ runs: [] });
    expect(await publish(REPO, result, 1000, api, 'https://example.test/run')).toBe('created');
    expect(created).toEqual([
      {
        sha: HEAD,
        run: {
          conclusion: 'success',
          title: 'Ready',
          summary: 'Ready\n\nWorked out at abcdef1.',
          externalId: '1000',
          detailsUrl: 'https://example.test/run',
        },
      },
    ]);
  });

  test('updates the existing line so each commit has one (AC10 logic)', async () => {
    const runs = [run('Ready', 'completed', 'failure', 5, { externalId: '900' }), run('Ready', 'completed', 'failure', 9, { externalId: '950' })];
    const { api, created, updated } = fakes({ runs });
    expect(await publish(REPO, result, 1000, api)).toBe('updated');
    expect(created).toEqual([]);
    expect(updated.map((u) => u.id)).toEqual([9]);
  });

  test('an older run never overwrites a newer result (AC10 logic)', async () => {
    const { api, created, updated } = fakes({ runs: [run('Ready', 'completed', 'success', 9, { externalId: '2000' })] });
    expect(await publish(REPO, result, 1000, api)).toBe('skipped');
    expect([...created, ...updated]).toEqual([]);
  });

  test('a Ready run from another app is not treated as ours', async () => {
    const { api, created } = fakes({ runs: [run('Ready', 'completed', 'success', 9, { appSlug: 'other', externalId: '9999' })] });
    expect(await publish(REPO, result, 1000, api)).toBe('created');
    expect(created).toHaveLength(1);
  });

  test('a could-not-check result publishes as neutral', async () => {
    const { api, created } = fakes({ runs: [] });
    await publish(REPO, { number: 700, headSha: HEAD, verdict: couldNotCheck(new Error('x')) }, 1, api);
    expect(created[0].run.conclusion).toBe('neutral');
    expect(created[0].run.title).toBe('Could not check. Re-run this check.');
  });
});

describe('arguments and selection', () => {
  test('parseArgs', () => {
    expect(parseArgs([])).toEqual({ publish: false, headSha: null, numbers: [] });
    expect(parseArgs(['--publish', '694', '#693'])).toEqual({ publish: true, headSha: null, numbers: [694, 693] });
    expect(parseArgs([`--head-sha=${HEAD.toUpperCase()}`]).headSha).toBe(HEAD);
    expect(() => parseArgs(['--head-sha=abc'])).toThrow('--head-sha needs a full commit SHA');
    expect(() => parseArgs(['--nope'])).toThrow('Unknown argument: --nope');
  });

  test('selectPulls', () => {
    const open = [pull({ number: 1 }), pull({ number: 3, headSha: 'f'.repeat(40) }), pull({ number: 2 })];
    expect(selectPulls(parseArgs([]), open).map((p) => p.number)).toEqual([3, 2, 1]);
    expect(selectPulls(parseArgs([`--head-sha=${HEAD}`]), open).map((p) => p.number)).toEqual([1, 2]);
    expect(selectPulls(parseArgs(['5']), open)).toEqual([]);
  });
});

describe('runCli', () => {
  function deps(f: ReturnType<typeof fakes>): { out: string[]; err: string[]; d: Parameters<typeof runCli>[1] } {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, d: { repo: REPO, api: f.api, git: f.git, startedAtMs: 5, out: (l) => out.push(l), err: (l) => err.push(l) } };
  }

  test('prints one session line per PR and publishes on request', async () => {
    const f = fakes({ runs: [run(BUILD, 'completed', 'success', 1), run(LINT, 'completed', 'success', 2)] });
    const { out, d } = deps(f);
    expect(await runCli(['--publish', '700', '701'], d)).toBe(0);
    expect(out).toEqual(['Ready #700 at abcdef1', '  check run created', 'Ready #701 at abcdef1', '  check run created']);
    expect(f.created).toHaveLength(2);
  });

  test('prints the error under a could-not-check line', async () => {
    const { out, err, d } = deps(fakes({ fail: 'compare' }));
    expect(await runCli([], d)).toBe(0);
    expect(out).toEqual(['Could not check. Re-run this check. #700 at abcdef1']);
    expect(err).toEqual(['  GET compare failed: HTTP 403']);
  });

  test('exits 1 with "Could not check" when the PR list cannot be read', async () => {
    const { out, err, d } = deps(fakes({ fail: 'listOpenPulls' }));
    expect(await runCli(['694'], d)).toBe(1);
    expect(out).toEqual(['Could not check. Re-run this check. #694 at an unknown commit']);
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
        check_runs: [{ id: 4, name: BUILD, status: 'completed', conclusion: 'success', external_id: null, app: null }],
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
      { id: 4, name: BUILD, status: 'completed', conclusion: 'success', appId: null, appSlug: '', externalId: '' },
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
      const r = { id: runPage, name: 'n', status: 'queued', conclusion: null, external_id: 'e', app: { id: 1, slug: 's' } };
      return Response.json({ check_runs: Array.from({ length: runPage === 1 ? 100 : 0 }, () => r) });
    };
    const api = realApi(undefined, impl);
    expect(await api.listOpenPulls(REPO)).toHaveLength(101);
    expect(await api.listCheckRuns(REPO, HEAD)).toHaveLength(100);
    expect(runPage).toBe(2);
  });

  test('creates and updates check runs', async () => {
    const f = fakeFetch({});
    const api = realApi(undefined, f.impl);
    const write: CheckRunWrite = { conclusion: 'failure', title: 't', summary: 's', externalId: '1', detailsUrl: 'u' };
    await api.createCheckRun(REPO, HEAD, write);
    await api.updateCheckRun(REPO, 9, { ...write, detailsUrl: undefined });
    expect(f.calls.map((c) => [c.init.method, c.url])).toEqual([
      ['POST', `https://api.github.com/repos/${REPO}/check-runs`],
      ['PATCH', `https://api.github.com/repos/${REPO}/check-runs/9`],
    ]);
    expect(JSON.parse(f.calls[0].init.body as string)).toEqual({
      name: 'Ready',
      head_sha: HEAD,
      status: 'completed',
      conclusion: 'failure',
      external_id: '1',
      details_url: 'u',
      output: { title: 't', summary: 's' },
    });
    expect(JSON.parse(f.calls[1].init.body as string).details_url).toBeUndefined();
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  test('a refused or rate-limited request throws so the check reads "Could not check"', async () => {
    const api = realApi('t', fakeFetch({}, 403).impl);
    await expect(api.getPull(REPO, 1)).rejects.toThrow(`GET ${REPO}/pulls/1 failed: HTTP 403`);
    await expect(api.createCheckRun(REPO, HEAD, { conclusion: 'neutral', title: 't', summary: 's', externalId: '1' })).rejects.toThrow(
      `POST ${REPO}/check-runs failed: HTTP 403`,
    );
    const limited = realApi('t', fakeFetch({}, 429).impl, async () => {});
    const { git } = fakes();
    const r = await checkPull(REPO, pull(), [], limited, git);
    expect(r.verdict.conclusion).toBe('neutral');
    expect(r.verdict.error).toBe(`GET ${REPO}/rules/branches/main?per_page=100 failed: HTTP 429`);
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

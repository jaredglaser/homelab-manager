import { describe, expect, test } from 'bun:test';
import {
  bumpVersion,
  changeKind,
  classify,
  contribKind,
  kindLabel,
  kindRank,
  lint,
  MARKER,
  proposalLine,
  renderBody,
  run,
  type GhApi,
  type GhComment,
  type Kind,
} from '../pr-version-impact';

function fakeApi(opts: {
  comments?: GhComment[];
  prTitles?: string[];
}): {
  api: GhApi;
  created: Array<{ issue: number; body: string }>;
  updated: Array<{ id: number; body: string }>;
} {
  const created: Array<{ issue: number; body: string }> = [];
  const updated: Array<{ id: number; body: string }> = [];
  const api: GhApi = {
    listIssueComments: async () => opts.comments ?? [],
    createIssueComment: async (_repo, issue, body) => {
      created.push({ issue, body });
    },
    updateIssueComment: async (_repo, id, body) => {
      updated.push({ id, body });
    },
    listOpenPrTitles: async () => opts.prTitles ?? [],
  };
  return { api, created, updated };
}

describe('classify and contribKind', () => {
  const matrix: Array<{
    name: string;
    title: string;
    body: string;
    version: string;
    parsed: boolean;
    type: string;
    breaking: boolean;
    kind: Kind;
  }> = [
    {
      name: 'fix bumps patch pre-1.0',
      title: 'fix: add restart policy to postgres',
      body: '',
      version: '0.2.0',
      parsed: true,
      type: 'fix',
      breaking: false,
      kind: 'patch',
    },
    {
      name: 'feat bumps patch pre-1.0',
      title: 'feat(hosts): view and rotate a JWK',
      body: '',
      version: '0.2.0',
      parsed: true,
      type: 'feat',
      breaking: false,
      kind: 'patch',
    },
    {
      name: 'feat! bumps minor pre-1.0',
      title: 'feat(api)!: remove v1 endpoints',
      body: '',
      version: '0.2.0',
      parsed: true,
      type: 'feat',
      breaking: true,
      kind: 'minor',
    },
    {
      name: 'fix! bumps minor pre-1.0',
      title: 'fix(api)!: drop the legacy scan',
      body: '',
      version: '0.2.0',
      parsed: true,
      type: 'fix',
      breaking: true,
      kind: 'minor',
    },
    {
      name: 'BREAKING CHANGE body token counts',
      title: 'feat(api): remove v1 endpoints',
      body: 'text\n\nBREAKING CHANGE: v1 endpoints removed\n\nmore',
      version: '0.2.0',
      parsed: true,
      type: 'feat',
      breaking: true,
      kind: 'minor',
    },
    {
      name: 'BREAKING-CHANGE body token counts',
      title: 'feat(api): remove v1 endpoints',
      body: 'text\n\nBREAKING-CHANGE: v1 endpoints removed',
      version: '0.2.0',
      parsed: true,
      type: 'feat',
      breaking: true,
      kind: 'minor',
    },
    {
      name: 'Breaking changes heading does not count',
      title: 'feat(api): remove v1 endpoints',
      body: '## Breaking changes\n\n- v1 endpoints removed',
      version: '0.2.0',
      parsed: true,
      type: 'feat',
      breaking: false,
      kind: 'patch',
    },
    {
      name: 'Breaking change prose does not count',
      title: 'feat(api): remove v1 endpoints',
      body: 'Breaking change: v1 endpoints removed',
      version: '0.2.0',
      parsed: true,
      type: 'feat',
      breaking: false,
      kind: 'patch',
    },
    {
      name: 'prose title is dropped entirely',
      title: 'Make the comment style scan mechanical',
      body: '',
      version: '0.2.0',
      parsed: false,
      type: '',
      breaking: false,
      kind: 'none',
    },
    {
      name: 'missing colon is dropped entirely',
      title: 'feat x',
      body: '',
      version: '0.2.0',
      parsed: false,
      type: '',
      breaking: false,
      kind: 'none',
    },
    {
      name: 'chore(deps) bumps patch',
      title: 'chore(deps): bump zod from 4.5.4 to 4.6.5',
      body: '',
      version: '0.2.0',
      parsed: true,
      type: 'chore',
      breaking: false,
      kind: 'patch',
    },
    {
      name: 'unknown type still bumps patch',
      title: 'wip: experimental thing',
      body: '',
      version: '0.2.0',
      parsed: true,
      type: 'wip',
      breaking: false,
      kind: 'patch',
    },
    {
      name: 'squash suffix parses',
      title: 'perf(monaco): import minimal editor core (#482)',
      body: '',
      version: '0.2.0',
      parsed: true,
      type: 'perf',
      breaking: false,
      kind: 'patch',
    },
    {
      name: 'feat! bumps major post-1.0',
      title: 'feat!: drop v1',
      body: '',
      version: '1.2.3',
      parsed: true,
      type: 'feat',
      breaking: true,
      kind: 'major',
    },
    {
      name: 'feat bumps minor post-1.0',
      title: 'feat(api): add a view',
      body: '',
      version: '1.2.3',
      parsed: true,
      type: 'feat',
      breaking: false,
      kind: 'minor',
    },
    {
      name: 'fix bumps patch post-1.0',
      title: 'fix: repair the scan',
      body: '',
      version: '1.2.3',
      parsed: true,
      type: 'fix',
      breaking: false,
      kind: 'patch',
    },
  ];

  for (const row of matrix) {
    test(row.name, () => {
      const cls = classify(row.title, row.body);
      expect(cls.parsed).toBe(row.parsed);
      expect(cls.type).toBe(row.type);
      expect(cls.breaking).toBe(row.breaking);
      expect(contribKind(row.version, cls)).toBe(row.kind);
    });
  }
});

describe('lint', () => {
  const cases: Array<{ title: string; ok: boolean; message: string }> = [
    {
      title: 'fix: add restart policy to postgres',
      ok: true,
      message: "OK: PR title classifies as 'fix' and release-please will version it.",
    },
    {
      title: 'chore(deps): bump zod from 4.5.4 to 4.6.5',
      ok: true,
      message: "OK: PR title classifies as 'chore' and release-please will version it.",
    },
    {
      title: 'feat!: drop v1',
      ok: true,
      message: "OK: PR title classifies as 'feat' (breaking) and release-please will version it.",
    },
    {
      title: 'Make the comment style scan mechanical',
      ok: false,
      message:
        'FAIL: PR title does not parse as a conventional commit: Make the comment style scan mechanical\n' +
        "release-please drops it entirely: no version bump, no changelog entry. Expected 'type(scope): summary', e.g. 'fix: ...', 'feat(hosts): ...'.",
    },
    {
      title: 'feat x',
      ok: false,
      message:
        'FAIL: PR title does not parse as a conventional commit: feat x\n' +
        "release-please drops it entirely: no version bump, no changelog entry. Expected 'type(scope): summary', e.g. 'fix: ...', 'feat(hosts): ...'.",
    },
    {
      title: 'wip: experimental thing',
      ok: false,
      message:
        "FAIL: unknown commit type 'wip'. Use one of: feat feature fix perf revert chore docs style refactor test build ci",
    },
  ];

  for (const c of cases) {
    test(`lint: ${c.title}`, () => {
      const result = lint(c.title, '');
      expect(result.ok).toBe(c.ok);
      expect(result.message).toBe(c.message);
    });
  }
});

describe('version math', () => {
  test('bumpVersion', () => {
    expect(bumpVersion('0.2.0', 'patch')).toBe('0.2.1');
    expect(bumpVersion('0.2.0', 'minor')).toBe('0.3.0');
    expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0');
    expect(bumpVersion('1.2.3', 'none')).toBe('1.2.3');
  });

  test('changeKind', () => {
    expect(changeKind('0.2.0', '0.2.0')).toBe('none');
    expect(changeKind('0.2.0', '0.2.1')).toBe('patch');
    expect(changeKind('0.2.0', '0.3.0')).toBe('minor');
    expect(changeKind('0.2.0', '1.0.0')).toBe('major');
  });

  test('kindRank orders the bumps', () => {
    expect(kindRank('none')).toBe(0);
    expect(kindRank('patch')).toBe(1);
    expect(kindRank('minor')).toBe(2);
    expect(kindRank('major')).toBe(3);
  });

  test('kindLabel', () => {
    expect(kindLabel('none')).toBe('nothing (see warning below)');
    expect(kindLabel('patch')).toBe('a **patch** bump');
    expect(kindLabel('minor')).toBe('a **minor** bump');
    expect(kindLabel('major')).toBe('a **major** bump');
  });
});

describe('renderBody', () => {
  test('renders the full comment byte-stable', () => {
    const expected = [
      '<!-- version-impact -->',
      '## Version impact',
      '',
      '| | |',
      '|---|---|',
      '| PR title | `fix: add restart policy to postgres` |',
      '| Conventional commit | `fix` |',
      '| Breaking change | no |',
      '| Current release | `v0.2.0` |',
      '| This PR contributes | a **patch** bump |',
      '| Next release if this PR lands alone | `v0.2.0` -> `v0.2.1` |',
      '| Changelog entry | shown |',
      '| Standing release PR | `v0.3.0` open. This PR does not change it |',
      '',
      'The release version is cut when the standing release-please PR merges. It batches everything merged since the last release and takes the strongest bump in the batch, so this row is this PR\'s contribution, not the final number. While the project is pre-1.0, `feat` and `fix` bump the patch and a breaking change bumps the minor. From 1.0.0 on, `feat` bumps the minor and a breaking change the major.',
      '',
      'Breaking changes must show as `type(scope)!: summary` or a `BREAKING CHANGE: ...` line in the PR body. Prose such as "Breaking changes" is invisible to release-please.',
      '',
      '',
      '',
    ].join('\n');
    const body = renderBody(
      'fix: add restart policy to postgres',
      '',
      '0.2.0',
      'patch',
      '`v0.3.0` open. This PR does not change it',
    );
    expect(body).toBe(expected);
  });

  test('breaking shows yes and minor contributes', () => {
    const body = renderBody('feat(api)!: remove v1 endpoints', '', '0.2.0', 'minor', 'none open yet');
    expect(body).toContain('| Breaking change | yes |');
    expect(body).toContain('| This PR contributes | a **minor** bump |');
    expect(body).toContain('| Next release if this PR lands alone | `v0.2.0` -> `v0.3.0` |');
  });

  test('unparseable title warns and hides from changelog', () => {
    const body = renderBody('Make the comment style scan mechanical', '', '0.2.0', 'none', 'none open yet');
    expect(body).toContain('| Conventional commit | **not a conventional commit** |');
    expect(body).toContain('| Next release if this PR lands alone | no contribution |');
    expect(body).toContain('| Changelog entry | missing |');
    expect(body).toContain('> :warning: **This PR title is not a conventional commit.**');
  });

  test('unknown type warns but still bumps', () => {
    const body = renderBody('wip: experimental thing', '', '0.2.0', 'patch', 'none open yet');
    expect(body).toContain('| Changelog entry | hidden (type `wip`) |');
    expect(body).toContain('> :warning: **Unrecognized type `wip`.**');
    expect(body).toContain('Use one of: feat feature fix perf revert chore docs style refactor test build ci.');
    expect(body).not.toContain('not a conventional commit**');
  });
});

describe('proposalLine', () => {
  const base = { repo: 'jaredglaser/homelab-manager' };

  test('no release PR open yet', async () => {
    const { api } = fakeApi({ prTitles: [] });
    const line = await proposalLine('0.2.0', 'patch', api, base.repo);
    expect(line).toBe('none open yet. The next run opens one at `v0.2.1` for this bump');
  });

  test('this PR raises the open proposal', async () => {
    const { api } = fakeApi({ prTitles: ['chore(main): release 0.2.1', 'fix: unrelated'] });
    const line = await proposalLine('0.2.0', 'minor', api, base.repo);
    expect(line).toBe('`v0.2.1` open. This PR raises it to `v0.3.0`');
  });

  test('this PR does not raise the open proposal', async () => {
    const { api } = fakeApi({ prTitles: ['chore(main): release 0.3.0'] });
    const line = await proposalLine('0.2.0', 'patch', api, base.repo);
    expect(line).toBe('`v0.3.0` open. This PR does not change it');
  });

  test('a none-kind PR never raises', async () => {
    const { api } = fakeApi({ prTitles: ['chore(main): release 0.2.1'] });
    const line = await proposalLine('0.2.0', 'none', api, base.repo);
    expect(line).toBe('`v0.2.1` open. This PR does not change it');
  });
});

describe('run', () => {
  const input = {
    repo: 'jaredglaser/homelab-manager',
    prNumber: '509',
    title: 'fix: add restart policy to postgres',
    body: '',
    version: '0.2.0',
  };
  const proposal = 'none open yet. The next run opens one at `v0.2.1` for this bump';
  const botComment = (id: number, body: string): GhComment => ({
    id,
    login: 'github-actions[bot]',
    body,
  });

  test('posts when no comment exists yet', async () => {
    const { api, created, updated } = fakeApi({ comments: [] });
    expect(await run(input, api)).toBe('Posted version impact comment.');
    expect(updated).toHaveLength(0);
    expect(created).toHaveLength(1);
    expect(created[0].issue).toBe(509);
    expect(created[0].body).toBe(renderBody(input.title, input.body, input.version, 'patch', proposal));
  });

  test('skips the edit when nothing changed', async () => {
    const body = renderBody(input.title, input.body, input.version, 'patch', proposal);
    const { api, created, updated } = fakeApi({ comments: [botComment(7, body)] });
    expect(await run(input, api)).toBe('Version impact comment unchanged; not editing.');
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  test('edits the existing comment in place', async () => {
    const { api, created, updated } = fakeApi({
      comments: [botComment(42, `${MARKER}\nstale content`)],
    });
    expect(await run(input, api)).toBe('Updated version impact comment 42.');
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe(42);
    expect(updated[0].body).toContain('## Version impact');
  });

  test('edits the newest matching comment', async () => {
    const { api, updated } = fakeApi({
      comments: [botComment(1, `${MARKER}\nold`), botComment(2, `${MARKER}\nstale`)],
    });
    await run(input, api);
    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe(2);
  });

  test('ignores comments from other users', async () => {
    const { api, created } = fakeApi({
      comments: [{ id: 9, login: 'someone-else', body: MARKER }],
    });
    expect(await run(input, api)).toBe('Posted version impact comment.');
    expect(created).toHaveLength(1);
  });
});

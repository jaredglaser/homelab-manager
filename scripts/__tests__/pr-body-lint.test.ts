import { describe, expect, test } from 'bun:test';

import { acceptanceIsCurrent, acceptanceSha, lintBody, runBodyLint } from '../pr-body-lint';

const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';
const STALE = 'Not ready: criteria were verified at 1a2b3c4 and the PR has moved since.';

function event(body: string | null, overrides: { ref?: string; login?: string } = {}): unknown {
  return {
    pull_request: {
      body,
      user: { login: overrides.login ?? 'someone' },
      head: { ref: overrides.ref ?? 'feature', sha: HEAD },
    },
  };
}

function run(ev: unknown): { code: number; out: string[] } {
  const out: string[] = [];
  const code = runBodyLint(JSON.stringify(ev), (l) => out.push(l));
  return { code, out };
}

describe('acceptanceSha', () => {
  test('reads the SHA from the last heading', () => {
    expect(acceptanceSha('intro\n## Acceptance (verified at 1a2b3c4)\n| ID |\n')).toBe('1a2b3c4');
    expect(acceptanceSha('## Acceptance (verified at aaaaaaa)\n\n## Acceptance (verified at bbbbbbb)\n')).toBe('bbbbbbb');
    expect(acceptanceSha('## Acceptance\n| ID |')).toBeNull();
    expect(acceptanceSha('')).toBeNull();
  });
});

describe('acceptanceIsCurrent', () => {
  test('a short or full SHA that prefixes the head is current', () => {
    expect(acceptanceIsCurrent('abcdef1', HEAD)).toBe(true);
    expect(acceptanceIsCurrent(HEAD.toUpperCase(), HEAD)).toBe(true);
    expect(acceptanceIsCurrent('abcdef2', HEAD)).toBe(false);
    expect(acceptanceIsCurrent('abc', HEAD)).toBe(false);
    expect(acceptanceIsCurrent('<head SHA>', HEAD)).toBe(false);
  });
});

describe('PR Body Lint', () => {
  test('no Acceptance table passes (AC6)', () => {
    expect(run(event('A small fix.'))).toEqual({ code: 0, out: ['OK: the description has no Acceptance table.'] });
    expect(lintBody(event(null)).ok).toBe(true);
  });

  test('a table at the head passes, short or full SHA', () => {
    expect(run(event('## Acceptance (verified at abcdef1)\n'))).toEqual({
      code: 0,
      out: ['OK: criteria were verified at the head commit abcdef1.'],
    });
    expect(lintBody(event(`## Acceptance (verified at ${HEAD})\n`)).ok).toBe(true);
  });

  test('a stale table fails with message w8 and an error annotation', () => {
    expect(run(event('## Acceptance (verified at 1a2b3c4d5e)\n'))).toEqual({
      code: 1,
      out: [`::error title=PR Body Lint::${STALE}`, STALE],
    });
  });

  test('a value that is not a SHA is quoted as written and the annotation is escaped', () => {
    expect(run(event('## Acceptance (verified at 100% done)\n')).out).toEqual([
      '::error title=PR Body Lint::Not ready: criteria were verified at 100%25 done and the PR has moved since.',
      'Not ready: criteria were verified at 100% done and the PR has moved since.',
    ]);
  });

  test('release-please and Dependabot heads pass even with a stale table', () => {
    const stale = '## Acceptance (verified at 1a2b3c4)\n';
    expect(lintBody(event(stale, { ref: 'release-please--branches--main' })).ok).toBe(true);
    expect(lintBody(event(stale, { login: 'dependabot[bot]' }))).toEqual({
      ok: true,
      message: 'OK: release-please and Dependabot PRs carry no Acceptance table.',
    });
  });

  test('a payload with no pull_request fails', () => {
    expect(run({})).toEqual({
      code: 1,
      out: ['::error title=PR Body Lint::FAIL: the event payload has no pull_request.', 'FAIL: the event payload has no pull_request.'],
    });
    expect(lintBody(null).ok).toBe(false);
  });
});

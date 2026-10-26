import { describe, expect, test } from 'bun:test';
import {
  compareVersions,
  constraintFromTag,
  matchesConstraint,
  newestTagMatchingConstraint,
  newestVersionTag,
  parseVersionTag,
} from '../version';

describe('parseVersionTag', () => {
  test('parses major-only tags', () => {
    expect(parseVersionTag('2')).toEqual({
      major: 2, minor: null, patch: null, prerelease: null, variant: null, raw: '2',
    });
  });

  test('parses major.minor and major.minor.patch', () => {
    expect(parseVersionTag('7.4')?.minor).toBe(4);
    expect(parseVersionTag('7.4')?.patch).toBeNull();
    expect(parseVersionTag('7.4.1')?.patch).toBe(1);
  });

  test('strips a leading v only when a digit follows', () => {
    expect(parseVersionTag('v2.1.0')?.major).toBe(2);
    expect(parseVersionTag('V3')?.major).toBe(3);
    expect(parseVersionTag('vault')).toBeNull();
  });

  test('splits variant suffixes from prereleases', () => {
    expect(parseVersionTag('7-alpine')?.variant).toBe('alpine');
    expect(parseVersionTag('2-bookworm')?.variant).toBe('bookworm');
    expect(parseVersionTag('1.0.0-rc.1')?.prerelease).toBe('rc.1');
    expect(parseVersionTag('1.0.0-beta2')?.prerelease).toBe('beta2');
  });

  test('floating and non-numeric tags return null', () => {
    for (const tag of ['latest', 'main', 'stable', 'edge', 'nightly', 'amd64', 'sha256-abc', '']) {
      expect(parseVersionTag(tag)).toBeNull();
    }
  });

  test('digest refs return null', () => {
    expect(parseVersionTag('sha256:' + 'a'.repeat(64))).toBeNull();
  });

  test('more than three numeric parts return null', () => {
    expect(parseVersionTag('1.2.3.4')).toBeNull();
  });
});

describe('constraintFromTag', () => {
  test('major-only tag constrains the major only', () => {
    expect(constraintFromTag('2')).toEqual({ major: 2, minor: null, patch: null, variant: null, allowPrerelease: false });
  });

  test('pinned fields carry into the constraint', () => {
    expect(constraintFromTag('7.4')).toEqual({ major: 7, minor: 4, patch: null, variant: null, allowPrerelease: false });
    expect(constraintFromTag('7.4.1')).toEqual({ major: 7, minor: 4, patch: 1, variant: null, allowPrerelease: false });
    expect(constraintFromTag('7-alpine')).toEqual({ major: 7, minor: null, patch: null, variant: 'alpine', allowPrerelease: false });
  });

  test('a prerelease running tag allows prerelease candidates', () => {
    expect(constraintFromTag('8.1.0-rc.1')?.allowPrerelease).toBe(true);
  });

  test('floating tags produce no constraint', () => {
    expect(constraintFromTag('latest')).toBeNull();
    expect(constraintFromTag('main')).toBeNull();
  });
});

describe('matchesConstraint', () => {
  const v = (tag: string) => parseVersionTag(tag)!;

  test('major constraint accepts newer minors and patches', () => {
    const c = constraintFromTag('2')!;
    expect(matchesConstraint(v('2.0.1'), c)).toBe(true);
    expect(matchesConstraint(v('2.9'), c)).toBe(true);
    expect(matchesConstraint(v('3.0'), c)).toBe(false);
    expect(matchesConstraint(v('1.9'), c)).toBe(false);
  });

  test('minor constraint accepts newer patches only', () => {
    const c = constraintFromTag('2.3')!;
    expect(matchesConstraint(v('2.3.9'), c)).toBe(true);
    expect(matchesConstraint(v('2.4.0'), c)).toBe(false);
  });

  test('patch constraint is exact', () => {
    const c = constraintFromTag('2.3.1')!;
    expect(matchesConstraint(v('2.3.1'), c)).toBe(true);
    expect(matchesConstraint(v('2.3.2'), c)).toBe(false);
  });

  test('variant must match exactly', () => {
    const c = constraintFromTag('7-alpine')!;
    expect(matchesConstraint(v('7.4.1-alpine'), c)).toBe(true);
    expect(matchesConstraint(v('7.4.1'), c)).toBe(false);
    expect(matchesConstraint(v('7.4.1-bookworm'), c)).toBe(false);
  });

  test('prerelease candidates never match a stable running tag', () => {
    const c = constraintFromTag('8')!;
    expect(matchesConstraint(v('8.1.0-rc.1'), c)).toBe(false);
    expect(matchesConstraint(v('8.1.0'), c)).toBe(true);
  });

  test('a prerelease running tag matches both prereleases and finals', () => {
    const c = constraintFromTag('8.1.0-rc.1')!;
    expect(matchesConstraint(v('8.1.0-rc.2'), c)).toBe(true);
    expect(matchesConstraint(v('8.1.0'), c)).toBe(true);
  });
});

describe('compareVersions', () => {
  const v = (tag: string) => parseVersionTag(tag)!;

  test('numeric fields compare numerically', () => {
    expect(compareVersions(v('2.10.0'), v('2.9.9'))).toBeGreaterThan(0);
    expect(compareVersions(v('2.0'), v('2.0.0'))).toBe(0);
    expect(compareVersions(v('1.9'), v('2.0'))).toBeLessThan(0);
  });

  test('prerelease ranks below the final release', () => {
    expect(compareVersions(v('1.0.0-rc.1'), v('1.0.0'))).toBeLessThan(0);
    expect(compareVersions(v('1.0.0-rc.2'), v('1.0.0-rc.1'))).toBeGreaterThan(0);
    expect(compareVersions(v('1.0.0-alpha'), v('1.0.0-beta'))).toBeLessThan(0);
  });
});

describe('newestVersionTag', () => {
  test('picks the highest version and ignores non-version tags', () => {
    expect(newestVersionTag(['latest', '7.4.1', '7', '7.10'])?.raw).toBe('7.10');
    expect(newestVersionTag(['7.10', '8.0.0-rc.1'])?.raw).toBe('8.0.0-rc.1');
  });

  test('returns null when nothing parses', () => {
    expect(newestVersionTag(['latest', 'main'])).toBeNull();
  });
});

describe('newestTagMatchingConstraint', () => {
  test('a :2 pin finds the newest 2.x, never 3.x', () => {
    const tags = ['2', '2.0.0', '2.9.4', '3.0.0', 'latest'];
    expect(newestTagMatchingConstraint(tags, constraintFromTag('2')!)?.raw).toBe('2.9.4');
  });

  test('variant constraint stays within the variant', () => {
    const tags = ['7-alpine', '7.4.1-alpine', '7.4.1', '8-alpine'];
    expect(newestTagMatchingConstraint(tags, constraintFromTag('7-alpine')!)?.raw).toBe('7.4.1-alpine');
  });

  test('returns null when no tag matches', () => {
    expect(newestTagMatchingConstraint(['3.0.0'], constraintFromTag('2')!)).toBeNull();
  });
});

import { describe, expect, test } from 'bun:test';
import {
  compareVersions,
  constraintFromTag,
  matchesConstraint,
  normalizeVersion,
  resolveRunningVersion,
} from '../version';

describe('normalizeVersion', () => {
  // real-world tags → the common comparison schema
  const table: Array<[string, { major: number; minor: number | null; patch: number | null; prerelease: string | null; variant: string | null } | null]> = [
    ['2', { major: 2, minor: null, patch: null, prerelease: null, variant: null }],
    ['2-alpine', { major: 2, minor: null, patch: null, prerelease: null, variant: 'alpine' }],
    ['2.11.7-alpine', { major: 2, minor: 11, patch: 7, prerelease: null, variant: 'alpine' }],
    ['v2.11.7', { major: 2, minor: 11, patch: 7, prerelease: null, variant: null }],
    ['V3', { major: 3, minor: null, patch: null, prerelease: null, variant: null }],
    ['2.11.7+build.5', { major: 2, minor: 11, patch: 7, prerelease: null, variant: null }],
    ['1.2.3-rc.1+build', { major: 1, minor: 2, patch: 3, prerelease: 'rc.1', variant: null }],
    ['2024.11.0', { major: 2024, minor: 11, patch: 0, prerelease: null, variant: null }],
    ['24.04', { major: 24, minor: 4, patch: null, prerelease: null, variant: null }],
    ['7.4', { major: 7, minor: 4, patch: null, prerelease: null, variant: null }],
    ['7', { major: 7, minor: null, patch: null, prerelease: null, variant: null }],
    ['1.0.0-rc.1', { major: 1, minor: 0, patch: 0, prerelease: 'rc.1', variant: null }],
    ['1.0.0-beta2', { major: 1, minor: 0, patch: 0, prerelease: 'beta2', variant: null }],
    ['1.0.0-rc.1-alpine', { major: 1, minor: 0, patch: 0, prerelease: 'rc.1', variant: 'alpine' }],
    ['1.0.0-rc.1-slim-bookworm', { major: 1, minor: 0, patch: 0, prerelease: 'rc.1', variant: 'slim-bookworm' }],
    ['1.0.0-rc.1-foo', { major: 1, minor: 0, patch: 0, prerelease: 'rc.1-foo', variant: null }],
    ['2.11.7-slim-bookworm', { major: 2, minor: 11, patch: 7, prerelease: null, variant: 'slim-bookworm' }],
    ['2.11.7-alpine3.20', { major: 2, minor: 11, patch: 7, prerelease: null, variant: 'alpine3.20' }],
    ['v2', { major: 2, minor: null, patch: null, prerelease: null, variant: null }],
    ['1.0.0-alpha-beta', { major: 1, minor: 0, patch: 0, prerelease: 'alpha-beta', variant: null }],
    ['1.0.0-0', { major: 1, minor: 0, patch: 0, prerelease: null, variant: '0' }],
    ['2.01', { major: 2, minor: 1, patch: null, prerelease: null, variant: null }],
    ['01.2.3', { major: 1, minor: 2, patch: 3, prerelease: null, variant: null }],
    ['10.0.0-rc.1-x64', { major: 10, minor: 0, patch: 0, prerelease: 'rc.1', variant: 'x64' }],
    ['2.11.7-ALPINE', { major: 2, minor: 11, patch: 7, prerelease: null, variant: 'ALPINE' }],
    ['V2.11.7-rc.1', { major: 2, minor: 11, patch: 7, prerelease: 'rc.1', variant: null }],
    ['2.11.7-alpine ', { major: 2, minor: 11, patch: 7, prerelease: null, variant: 'alpine' }],
    ['2.11.7 alpine', null],
    ['1.0.0-rc..1', null],
    ['1.0.0-rc.01', null],
    ['latest', null],
    ['main', null],
    ['stable', null],
    ['edge', null],
    ['nightly', null],
    ['amd64', null],
    ['vault', null],
    ['sha256-abc', null],
    ['sha256:' + 'a'.repeat(64), null],
    ['1.2.3.4', null],
    ['1.0.0-rc.1!', null],
    ['', null],
  ];

  test('translates the common conventions into one schema', () => {
    for (const [raw, expected] of table) {
      const parsed = normalizeVersion(raw);
      if (expected === null) {
        expect(parsed).toBeNull();
        continue;
      }
      expect(parsed?.major).toBe(expected.major);
      expect(parsed?.minor).toBe(expected.minor);
      expect(parsed?.patch).toBe(expected.patch);
      expect(parsed?.prerelease).toBe(expected.prerelease);
      expect(parsed?.variant).toBe(expected.variant);
      expect(parsed?.raw).toBe(raw);
    }
  });

  test('pads the core for comparison', () => {
    expect(normalizeVersion('2')?.semver.version).toBe('2.0.0');
    expect(normalizeVersion('7.4')?.semver.version).toBe('7.4.0');
    expect(normalizeVersion('1.0.0-rc.1')?.semver.version).toBe('1.0.0-rc.1');
  });
});

describe('constraintFromTag', () => {
  test('major-only tag constrains the major only', () => {
    const c = constraintFromTag('2')!;
    expect(c.major).toBe(2);
    expect(c.minor).toBeNull();
    expect(c.patch).toBeNull();
    expect(c.variant).toBeNull();
    expect(c.allowPrerelease).toBe(false);
  });

  test('pinned fields carry into the constraint', () => {
    expect(constraintFromTag('7.4')?.minor).toBe(4);
    expect(constraintFromTag('7.4')?.patch).toBeNull();
    expect(constraintFromTag('7.4.1')?.patch).toBe(1);
    expect(constraintFromTag('7-alpine')?.variant).toBe('alpine');
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
  const v = (tag: string) => normalizeVersion(tag)!;

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

  test('a prerelease running tag matches both prereleases and finals in its range', () => {
    const c = constraintFromTag('8.1.0-rc.1')!;
    expect(matchesConstraint(v('8.1.0-rc.2'), c)).toBe(true);
    expect(matchesConstraint(v('8.1.0'), c)).toBe(true);
  });

  test('a prerelease running tag on a major-only pin admits prereleases inside the major', () => {
    const c = constraintFromTag('2-rc.1')!;
    expect(matchesConstraint(v('2.0.0-rc.2'), c)).toBe(true);
    expect(matchesConstraint(v('2.5.0-beta'), c)).toBe(true);
    expect(matchesConstraint(v('3.0.0-rc.1'), c)).toBe(false);
    expect(matchesConstraint(v('1.9.0'), c)).toBe(false);
  });

  test('a prerelease running tag on a minor pin admits prereleases inside the minor', () => {
    const c = constraintFromTag('2.1-rc.1')!;
    expect(matchesConstraint(v('2.1.0-rc.2'), c)).toBe(true);
    expect(matchesConstraint(v('2.1.5-rc.1'), c)).toBe(true);
    expect(matchesConstraint(v('2.2.0-rc.1'), c)).toBe(false);
  });

  test('a prerelease running tag on a patch pin admits only that patch', () => {
    const c = constraintFromTag('2.3.1-rc.1')!;
    expect(matchesConstraint(v('2.3.1-rc.2'), c)).toBe(true);
    expect(matchesConstraint(v('2.3.1'), c)).toBe(true);
    expect(matchesConstraint(v('2.3.2-rc.1'), c)).toBe(false);
  });

  test('a candidate with a variant fails a variant-less constraint', () => {
    const c = constraintFromTag('2.3')!;
    expect(matchesConstraint(v('2.3.9-alpine'), c)).toBe(false);
  });
});

describe('compareVersions', () => {
  const v = (tag: string) => normalizeVersion(tag)!;

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

  test('build metadata is ignored for precedence', () => {
    expect(compareVersions(v('2.11.7+build.5'), v('2.11.7'))).toBe(0);
  });
});

describe('resolveRunningVersion', () => {
  const v = (tag: string) => normalizeVersion(tag)!;

  test('a label agreeing with the pinned axes is trusted', () => {
    const c = constraintFromTag('2-alpine')!;
    const result = resolveRunningVersion(c, v('v2.11.7'), v('2-alpine'));
    expect(result.current?.raw).toBe('v2.11.7');
    expect(result.versionSource).toBe('label');
  });

  test('a label disagreeing with the pinned major is distrusted', () => {
    const c = constraintFromTag('2-alpine')!;
    const result = resolveRunningVersion(c, v('2024.11.0'), v('2-alpine'));
    expect(result.current?.raw).toBe('2-alpine');
    expect(result.versionSource).toBe('tag');
  });

  test('a label disagreeing with a pinned minor is distrusted', () => {
    const c = constraintFromTag('7.4-alpine')!;
    const result = resolveRunningVersion(c, v('7.9.0'), v('7.4-alpine'));
    expect(result.versionSource).toBe('tag');
  });

  test('a label agreeing on the pinned minor is trusted', () => {
    const c = constraintFromTag('7.4-alpine')!;
    const result = resolveRunningVersion(c, v('7.4.1'), v('7.4-alpine'));
    expect(result.versionSource).toBe('label');
  });

  test('a null label falls back to the tag', () => {
    const c = constraintFromTag('2-alpine')!;
    const result = resolveRunningVersion(c, null, v('2-alpine'));
    expect(result.versionSource).toBe('tag');
  });

  test('no usable source yields null', () => {
    const c = constraintFromTag('2-alpine')!;
    const result = resolveRunningVersion(c, null, null);
    expect(result.current).toBeNull();
    expect(result.versionSource).toBeNull();
  });

  test('a final label on a prerelease running tag is distrusted so rc updates stay visible', () => {
    const c = constraintFromTag('2.3.1-rc.1')!;
    const result = resolveRunningVersion(c, v('2.3.1'), v('2.3.1-rc.1'));
    expect(result.current?.raw).toBe('2.3.1-rc.1');
    expect(result.versionSource).toBe('tag');
  });

  test('a prerelease label on a stable running tag is distrusted', () => {
    const c = constraintFromTag('2.3.1')!;
    const result = resolveRunningVersion(c, v('2.3.1-rc.1'), v('2.3.1'));
    expect(result.versionSource).toBe('tag');
  });
});

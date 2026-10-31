/** Version-tag parsing and constraint matching for image update checks. */
import { compare as semverCompare, parse as semverParse, Range } from 'semver';
import type { SemVer } from 'semver';

export interface ParsedVersionTag {
  major: number;
  minor: number | null;
  patch: number | null;
  /** Raw prerelease suffix (`rc.1`, `beta2`), ordered before the same version without one. */
  prerelease: string | null;
  /** Platform/variant suffix (`alpine`, `slim-bookworm`), matched by exact string. */
  variant: string | null;
  raw: string;
  /** Parsed zero-padded core including the prerelease; the comparison source of truth. */
  semver: SemVer;
}

export interface TagConstraint {
  major: number;
  minor: number | null;
  patch: number | null;
  variant: string | null;
  /** True when the running tag itself is a prerelease, in which case only prerelease candidates match. */
  allowPrerelease: boolean;
  /** Compiled once per constraint with includePrerelease baked in; encodes the pinned axes. */
  range: Range;
}

const PRERELEASE_PREFIX = /^(alpha|beta|rc|pre|preview|dev|canary|nightly|next|test|snapshot)/i;

// Only consulted to split prerelease+variant combos (`1.0.0-rc.1-alpine`); a
// suffix with no prerelease segment stays a variant whatever it says, so a
// stale vocabulary entry can only misclassify a combo, never a plain variant.
const VARIANT_VOCABULARY = new Set([
  'alpine', 'slim', 'bookworm', 'bullseye', 'buster', 'stretch', 'trixie',
  'jammy', 'noble', 'focal',
  'arm64', 'armv7', 'armhf', 'aarch64', 'amd64', 'arm', 'x86_64', '386',
  'riscv64', 'ppc64le', 's390x',
]);
const VARIANT_PATTERNS = [/^alpine3\.\d+$/];

function isVariantSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  return VARIANT_VOCABULARY.has(lower) || VARIANT_PATTERNS.some((pattern) => pattern.test(lower));
}

/**
 * Translate a version-ish string (registry tag, OCI version label, GitHub
 * release tag) into the common comparison schema. Handles the conventions in
 * the wild: leading `v`, semver build metadata, dash suffixes that are a
 * prerelease, a Docker variant, or both (`1.0.0-rc.1-alpine`). Returns null
 * for floating tags, digest refs, and anything without a numeric major.
 */
export function normalizeVersion(raw: string): ParsedVersionTag | null {
  let rest = raw.trim();
  if (!rest || rest.startsWith('sha256:')) return null;
  if ((rest.startsWith('v') || rest.startsWith('V')) && /^\d/.test(rest.slice(1))) rest = rest.slice(1);
  if (!/^\d/.test(rest)) return null;

  const plus = rest.indexOf('+');
  if (plus !== -1) rest = rest.slice(0, plus);

  let variant: string | null = null;
  let prerelease: string | null = null;
  const dash = rest.indexOf('-');
  if (dash !== -1) {
    const segments = rest.slice(dash + 1).split('-');
    rest = rest.slice(0, dash);
    const firstPre = segments.findIndex((segment) => PRERELEASE_PREFIX.test(segment));
    if (firstPre === -1) {
      variant = segments.join('-');
    } else {
      let end = segments.length;
      while (end > firstPre + 1 && isVariantSegment(segments[end - 1])) end--;
      prerelease = segments.slice(firstPre, end).join('-') || null;
      variant = [...segments.slice(0, firstPre), ...segments.slice(end)].join('-') || null;
    }
  }

  const parts = rest.split('.');
  if (parts.length === 0 || parts.length > 3) return null;
  if (!parts.every((part) => /^\d+$/.test(part))) return null;
  const [major, minor = null, patch = null] = parts.map(Number);
  const padded = `${major}.${minor ?? 0}.${patch ?? 0}`;
  const parsed = semverParse(prerelease ? `${padded}-${prerelease}` : padded);
  if (!parsed) return null;

  return { major, minor, patch, prerelease, variant, raw, semver: parsed };
}

function buildRange(major: number, minor: number | null, patch: number | null, allowPrerelease: boolean): Range {
  // The -0 upper bound excludes the next axis's prereleases even when
  // includePrerelease is on (3.0.0-rc.1 must not satisfy a :2 pin); the -0
  // lower bound lets a constraint that is itself a prerelease admit its
  // siblings (2.0.0-rc.2 against a 2.0.0-rc.1 running tag).
  const lower = allowPrerelease ? '-0' : '';
  if (patch !== null) {
    return allowPrerelease
      ? new Range(`>=${major}.${minor}.${patch}-0 <${major}.${minor}.${patch + 1}-0`, { includePrerelease: true })
      : new Range(`${major}.${minor}.${patch}`, { includePrerelease: false });
  }
  if (minor !== null) {
    return new Range(`>=${major}.${minor}.0${lower} <${major}.${minor + 1}.0-0`, { includePrerelease: allowPrerelease });
  }
  return new Range(`>=${major}.0.0${lower} <${major + 1}.0.0-0`, { includePrerelease: allowPrerelease });
}

/** Constraint a running tag imposes on update candidates, null when the tag is floating. */
export function constraintFromTag(tag: string): TagConstraint | null {
  const parsed = normalizeVersion(tag);
  if (!parsed) return null;
  const allowPrerelease = parsed.prerelease !== null;
  return {
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    variant: parsed.variant,
    allowPrerelease,
    range: buildRange(parsed.major, parsed.minor, parsed.patch, allowPrerelease),
  };
}

export function matchesConstraint(version: ParsedVersionTag, constraint: TagConstraint): boolean {
  if (version.prerelease !== null && !constraint.allowPrerelease) return false;
  if (version.major !== constraint.major) return false;
  if (constraint.minor !== null && version.minor !== constraint.minor) return false;
  if (constraint.patch !== null && version.patch !== constraint.patch) return false;
  if ((version.variant ?? null) !== (constraint.variant ?? null)) return false;
  return constraint.range.test(version.semver);
}

export function compareVersions(a: ParsedVersionTag, b: ParsedVersionTag): number {
  return semverCompare(a.semver, b.semver);
}

/**
 * Decide which version the container actually runs: the image's declared
 * version when it agrees with the axes the running tag pins (major always;
 * minor/patch when pinned), otherwise the tag-derived guess. A label claiming
 * a different scheme (`2024.11.0` behind a `2-alpine` tag) is distrusted
 * rather than allowed to suppress or fabricate updates.
 */
export function resolveRunningVersion(
  constraint: TagConstraint,
  labelVersion: ParsedVersionTag | null,
  tagFallback: ParsedVersionTag | null,
): { current: ParsedVersionTag | null; versionSource: 'label' | 'tag' | null } {
  const trusted = labelVersion !== null
    && labelVersion.major === constraint.major
    && (constraint.minor === null || labelVersion.minor === constraint.minor)
    && (constraint.patch === null || labelVersion.patch === constraint.patch);
  if (trusted) return { current: labelVersion, versionSource: 'label' };
  return { current: tagFallback, versionSource: tagFallback ? 'tag' : null };
}

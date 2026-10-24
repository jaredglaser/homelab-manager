/**
 * Version-tag parsing and constraint matching for image update checks.
 *
 * A running tag doubles as the update constraint: `redis:7` means "newest tag
 * with major 7", `redis:7.4` means "newest 7.4.x", `redis:7.4.1` pins exactly.
 * Variant suffixes (`7-alpine`, `2-bookworm`) must match too, so an alpine pin
 * is never "updated" to a debian tag. Floating tags (`latest`, `main`, `edge`,
 * digest pins) carry no constraint: nothing on the registry can be "newer than
 * latest" without comparing digests, which the web side has no data for.
 */

export interface ParsedVersionTag {
  major: number;
  minor: number | null;
  patch: number | null;
  /** Prerelease identifier (`rc.1`, `beta2`), ordered before the same version without one. */
  prerelease: string | null;
  /** Platform/variant suffix (`alpine`, `bookworm`, `slim`), matched by exact string. */
  variant: string | null;
  raw: string;
}

export interface TagConstraint {
  major: number;
  minor: number | null;
  patch: number | null;
  variant: string | null;
  /** True when the running tag itself is a prerelease; only then do prerelease candidates match. */
  allowPrerelease: boolean;
}

const PRERELEASE_PREFIX = /^(alpha|beta|rc|pre|preview|dev|canary|nightly|next|test|snapshot)/i;

/**
 * Parse a version-like tag (`2`, `7.4`, `v2.3.1`, `7-alpine`, `1.0.0-rc.1`).
 * Returns null for floating tags, digest-looking strings, and anything without
 * a leading numeric major.
 */
export function parseVersionTag(tag: string): ParsedVersionTag | null {
  let rest = tag.trim();
  if (!rest || rest.startsWith('sha256:')) return null;
  if (rest.startsWith('v') || rest.startsWith('V')) {
    const after = rest.slice(1);
    if (/^\d/.test(after)) rest = after;
  }
  if (!/^\d/.test(rest)) return null;

  let variant: string | null = null;
  let prerelease: string | null = null;
  const dash = rest.indexOf('-');
  if (dash !== -1) {
    const suffix = rest.slice(dash + 1);
    rest = rest.slice(0, dash);
    if (PRERELEASE_PREFIX.test(suffix)) {
      prerelease = suffix;
    } else {
      variant = suffix;
    }
  }

  const parts = rest.split('.');
  if (parts.length === 0 || parts.length > 3) return null;
  if (!parts.every((part) => /^\d+$/.test(part))) return null;
  const [major, minor = null, patch = null] = parts.map(Number);

  return { major, minor, patch, prerelease, variant, raw: tag };
}

/** Constraint a running tag imposes on update candidates, null when the tag is floating. */
export function constraintFromTag(tag: string): TagConstraint | null {
  const parsed = parseVersionTag(tag);
  if (!parsed) return null;
  return {
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    variant: parsed.variant,
    allowPrerelease: parsed.prerelease !== null,
  };
}

export function matchesConstraint(version: ParsedVersionTag, constraint: TagConstraint): boolean {
  if (version.prerelease !== null && !constraint.allowPrerelease) return false;
  if (version.major !== constraint.major) return false;
  if (constraint.minor !== null && version.minor !== constraint.minor) return false;
  if (constraint.patch !== null && version.patch !== constraint.patch) return false;
  return (version.variant ?? null) === (constraint.variant ?? null);
}

/** Semver-style ordering: numeric fields ascending, prerelease below final release. */
export function compareVersions(a: ParsedVersionTag, b: ParsedVersionTag): number {
  for (const field of ['major', 'minor', 'patch'] as const) {
    const av = a[field] ?? 0;
    const bv = b[field] ?? 0;
    if (av !== bv) return av - bv;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

function comparePrerelease(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const aParts = a.split('.');
  const bParts = b.split('.');
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const ap = aParts[i];
    const bp = bParts[i];
    if (ap === undefined) return -1;
    if (bp === undefined) return 1;
    const an = Number(ap);
    const bn = Number(bp);
    const aNumeric = Number.isFinite(an) && /^\d+$/.test(ap);
    const bNumeric = Number.isFinite(bn) && /^\d+$/.test(bp);
    if (aNumeric && bNumeric) {
      if (an !== bn) return an - bn;
    } else if (aNumeric !== bNumeric) {
      // Numeric identifiers sort below non-numeric ones.
      return aNumeric ? -1 : 1;
    } else if (ap !== bp) {
      return ap < bp ? -1 : 1;
    }
  }
  return 0;
}

/** Newest version-like tag among `tags` by version order, null when none parses. */
export function newestVersionTag(tags: string[]): ParsedVersionTag | null {
  let newest: ParsedVersionTag | null = null;
  for (const tag of tags) {
    const parsed = parseVersionTag(tag);
    if (!parsed) continue;
    if (newest === null || compareVersions(parsed, newest) > 0) newest = parsed;
  }
  return newest;
}

/** Newest tag satisfying `constraint`, null when none does. */
export function newestTagMatchingConstraint(
  tags: string[],
  constraint: TagConstraint,
): ParsedVersionTag | null {
  let newest: ParsedVersionTag | null = null;
  for (const tag of tags) {
    const parsed = parseVersionTag(tag);
    if (!parsed || !matchesConstraint(parsed, constraint)) continue;
    if (newest === null || compareVersions(parsed, newest) > 0) newest = parsed;
  }
  return newest;
}

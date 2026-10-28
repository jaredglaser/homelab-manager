/** Wire types for image update checks and image changelogs. */

/** Update check result for one image ref as a container runs it (e.g. `redis:7`). */
export interface ImageUpdateSummary {
  /** Full image ref the container runs, exactly as reported by the inventory. */
  image: string;
  /** Tag part of the ref, null for digest-only refs. */
  currentTag: string | null;
  /**
   * Newest registry tag matching the running tag's constraint (same major, and
   * minor/patch when the running tag pins them, and variant suffix). null when
   * the running tag is floating (`latest`, `main`, ...) or no matching tag exists.
   */
  latestMatchingTag: string | null;
  /**
   * Newest registry tag overall by version order, even when it falls outside the
   * running tag's constraint (e.g. 3.0 while running :2). null when the registry
   * publishes no version-like tags.
   */
  latestOverallTag: string | null;
  /**
   * true: a newer tag matching the constraint exists on the registry.
   * false: the running tag is the newest match.
   * null: unknown (floating tag, digest-only ref, or the registry check failed).
   */
  updateAvailable: boolean | null;
  /** `owner/repo` on GitHub that releases are pulled from, when the image carries an `org.opencontainers.image.source` label pointing at github.com. */
  sourceRepo: string | null;
  /** Why the registry check failed, when it did. */
  error: string | null;
  /** When this state was produced: the persisted row's checked_at, or the moment of a live check. Absent only from legacy callers. */
  checkedAt?: string | null;
}

/** One GitHub release for an image's source repository. */
export interface ImageRelease {
  tagName: string;
  name: string | null;
  /** ISO timestamp of the release publish date. */
  publishedAt: string | null;
  /** HTML URL of the release page. */
  url: string | null;
  /** Release notes body as markdown. */
  body: string | null;
  prerelease: boolean;
}

/** Release notes for one image, fetched from its source repository. */
export interface ImageChangelog {
  image: string;
  sourceRepo: string | null;
  releases: ImageRelease[];
  /** Why releases could not be fetched, when sourceRepo is missing or the API call failed. */
  error: string | null;
}

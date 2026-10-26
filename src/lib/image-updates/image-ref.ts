/**
 * Docker image reference parsing per the distribution-spec grammar, reduced to
 * what registry tag lookups need: which registry to query and which repository
 * path to ask it for.
 */

export interface ParsedImageRef {
  /** Normalized registry host: `docker.io` for implicit Docker Hub refs. */
  registry: string;
  /** Repository path as the registry expects it (`library/redis` for official images). */
  repo: string;
  /** Tag part, null when the ref pins a digest only. */
  tag: string | null;
  /** Digest part including its algorithm prefix (`sha256:...`), null when absent. */
  digest: string | null;
}

const IMPLICIT_REGISTRY = 'docker.io';
/** Spellings that all serve the same hub images as the implicit registry. */
const DOCKER_HUB_HOSTS = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);
const OFFICIAL_REPO_NAMESPACE = 'library/';

/** A ref that failed to parse (empty, or a tag/digest with no repository part). */
export class InvalidImageRefError extends Error {}

export function parseImageRef(image: string): ParsedImageRef {
  const trimmed = image.trim();
  if (!trimmed) throw new InvalidImageRefError('Image reference is empty');

  let rest = trimmed;
  let digest: string | null = null;
  const at = rest.indexOf('@');
  if (at !== -1) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!digest) throw new InvalidImageRefError(`Image reference "${image}" has an empty digest`);
  }

  let tag: string | null = null;
  const lastSlash = rest.lastIndexOf('/');
  const lastColon = rest.lastIndexOf(':');
  if (lastColon > lastSlash) {
    tag = rest.slice(lastColon + 1);
    rest = rest.slice(0, lastColon);
    if (!tag) throw new InvalidImageRefError(`Image reference "${image}" has an empty tag`);
  }

  let registry = IMPLICIT_REGISTRY;
  let repo = rest;
  const firstSlash = rest.indexOf('/');
  if (firstSlash !== -1) {
    const first = rest.slice(0, firstSlash);
    const lowerFirst = first.toLowerCase();
    // A leading component is a registry host when it looks like one: a dot
    // (ghcr.io), a port (localhost:5000), or the literal `localhost`.
    if (lowerFirst.includes('.') || lowerFirst.includes(':') || lowerFirst === 'localhost') {
      registry = DOCKER_HUB_HOSTS.has(lowerFirst) ? IMPLICIT_REGISTRY : lowerFirst;
      repo = rest.slice(firstSlash + 1);
    }
  }

  if (!repo) throw new InvalidImageRefError(`Image reference "${image}" has no repository part`);

  if (registry === IMPLICIT_REGISTRY && !repo.includes('/')) {
    repo = OFFICIAL_REPO_NAMESPACE + repo;
  }

  return { registry, repo, tag, digest };
}

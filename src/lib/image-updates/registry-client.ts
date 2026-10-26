import { parseImageRef } from './image-ref';
import {
  compareVersions,
  constraintFromTag,
  newestTagMatchingConstraint,
  newestVersionTag,
  parseVersionTag,
} from './version';
import { BoundedCache } from '@/lib/bounded-cache';
import type { ImageUpdateSummary } from '@/types/image-updates';

const REQUEST_TIMEOUT_MS = 10_000;
const TAG_LIST_BUDGET_MS = 15_000;
const TAG_LIST_MAX_PAGES = 10;
const TAG_LIST_PAGE_SIZE = 1000;
const DOCKER_HUB_API = 'https://hub.docker.com/v2';
const DOCKER_HUB_HOST = 'hub.docker.com';
const DOCKER_HUB_REGISTRY = 'https://registry-1.docker.io';

export class RegistryCheckError extends Error {}

const DEFAULT_ALLOWED_REGISTRIES = new Set([
  'docker.io',
  'ghcr.io',
  'quay.io',
  'gcr.io',
  'registry.k8s.io',
  'lscr.io',
]);

const REGISTRY_HOST_PATTERN = /^[a-z0-9][a-z0-9.-]*(?::\d{1,5})?$/;

export function parseExtraRegistries(value: string | undefined): string[] {
  if (value === undefined) return [];
  const entries = value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return entries.map((entry) => {
    if (!REGISTRY_HOST_PATTERN.test(entry.toLowerCase())) {
      throw new Error(
        'IMAGE_UPDATE_EXTRA_REGISTRIES entry "' + entry + '" is not a valid registry host. ' +
          'Use comma-separated hostnames with an optional port, for example IMAGE_UPDATE_EXTRA_REGISTRIES="nas.lan:5000,registry.home.arpa"',
      );
    }
    return entry.toLowerCase();
  });
}

const EXTRA_REGISTRIES = new Set(parseExtraRegistries(process.env.IMAGE_UPDATE_EXTRA_REGISTRIES));

export function isRegistryAllowed(registry: string, extraRegistries: ReadonlySet<string> = EXTRA_REGISTRIES): boolean {
  const host = registry.toLowerCase();
  return DEFAULT_ALLOWED_REGISTRIES.has(host) || extraRegistries.has(host);
}

interface RegistryEndpoints {
  base: string;
  /** Docker Hub tags live on the Hub API, not the registry v2 API. */
  hubRepo?: boolean;
}

function registryEndpoints(registry: string): RegistryEndpoints {
  if (registry === 'docker.io') return { base: DOCKER_HUB_API, hubRepo: true };
  return { base: 'https://' + registry };
}

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

const tokenCache = new BoundedCache<TokenCacheEntry>(300);

// The realm pin rejects hosts outside the fetch base plus these delegations
// (Docker Hub's registry endpoint issues tokens from auth.docker.io).
const DELEGATED_TOKEN_HOSTS = new Map<string, Set<string>>([
  ['registry-1.docker.io', new Set(['auth.docker.io'])],
]);

async function getPullToken(registry: string, repo: string, base: string): Promise<string | null> {
  const cacheKey = registry + '|' + repo;
  const cached = tokenCache.get(cacheKey);
  if (cached) return cached.token;

  const probe = await fetch(base + '/v2/', { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (probe.ok) return null;
  const authHeader = probe.headers.get('www-authenticate');
  const realm = authHeader?.match(/realm="([^"]+)"/)?.[1];
  if (probe.status !== 401 || !realm) {
    throw new RegistryCheckError(
      'Registry ' + registry + ' does not allow anonymous tag access, so its update state cannot be checked.',
    );
  }
  const service = authHeader?.match(/service="([^"]+)"/)?.[1];
  const scope = 'repository:' + repo + ':pull';
  const realmUrl = new URL(realm);
  const baseHost = new URL(base).host;
  const delegated = DELEGATED_TOKEN_HOSTS.get(baseHost);
  if (realmUrl.protocol !== 'https:' || (realmUrl.host !== baseHost && !delegated?.has(realmUrl.host))) {
    throw new RegistryCheckError(
      'Registry ' + registry + ' pointed its token endpoint at an unexpected host, so the update check stopped for safety.',
    );
  }
  const tokenUrl = realmUrl;
  if (service) tokenUrl.searchParams.set('service', service);
  tokenUrl.searchParams.set('scope', scope);
  const tokenResponse = await fetch(tokenUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!tokenResponse.ok) {
    console.error('[image-updates] registry ' + registry + ' token endpoint returned ' + tokenResponse.status);
    throw new RegistryCheckError(
      'Registry ' + registry + ' failed to issue a read token, so its update state cannot be checked.',
    );
  }
  const body = (await tokenResponse.json()) as { token?: string; access_token?: string };
  const token = body.token ?? body.access_token;
  if (!token) {
    throw new RegistryCheckError(
      'Registry ' + registry + ' did not return a usable read token, so its update state cannot be checked.',
    );
  }
  const exp = decodeJwtExp(token);
  const expiresAt = exp ?? Date.now() + 5 * 60_000;
  tokenCache.set(cacheKey, { token, expiresAt }, expiresAt - Date.now());
  return token;
}

function decodeJwtExp(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return typeof decoded.exp === 'number' ? decoded.exp * 1000 : null;
  } catch {
    return null;
  }
}

interface TagPage {
  results?: Array<{ name?: string }>;
  next?: string | null;
}

function budgetRemaining(deadline: number, registry: string): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new RegistryCheckError(
      'Listing tags from ' + registry + ' took too long, so the update state could not be checked.',
    );
  }
  return remaining;
}

function budgetedFetch(url: string, init: RequestInit, deadline: number, registry: string): Promise<Response> {
  const remaining = budgetRemaining(deadline, registry);
  return fetch(url, { ...init, signal: AbortSignal.timeout(remaining) });
}

async function fetchDockerHubTags(repo: string, deadline: number): Promise<string[]> {
  budgetRemaining(deadline, 'docker.io');
  const tags: string[] = [];
  let url: string | null = DOCKER_HUB_API + '/repositories/' + repo + '/tags?page_size=100';
  for (let page = 0; page < TAG_LIST_MAX_PAGES && url; page++) {
    const response = await budgetedFetch(url, {}, deadline, 'docker.io');
    if (response.status === 404) return tags;
    if (!response.ok) {
      console.error('[image-updates] Docker Hub returned ' + response.status + ' for ' + repo + ' tags');
      throw new RegistryCheckError(
        "Docker Hub failed to list tags for " + repo + ", so this image's update state cannot be checked.",
      );
    }
    const body = (await response.json()) as TagPage;
    for (const result of body.results ?? []) {
      if (result.name) tags.push(result.name);
    }
    const next = body.next ?? null;
    if (next && new URL(next).host !== DOCKER_HUB_HOST) {
      throw new RegistryCheckError('Docker Hub sent the next page from a different host, so the tag list stopped early.');
    }
    url = next;
  }
  return tags;
}

function nextLink(header: string | null, registry: string, baseHost: string): string | null {
  const match = header?.match(/<([^>]+)>\s*;\s*rel="next"/) ?? header?.match(/<([^>]+)>/);
  if (!match) return null;
  const next = new URL(match[1], 'https://' + baseHost);
  if (next.host !== baseHost) {
    throw new RegistryCheckError(
      'Registry ' + registry + ' sent the next page from a different host, so the tag list stopped early.',
    );
  }
  return next.toString();
}

async function fetchV2Tags(registry: string, repo: string, base: string, deadline: number): Promise<string[]> {
  budgetRemaining(deadline, registry);
  const token = await getPullToken(registry, repo, base);
  const tags: string[] = [];
  const baseHost = new URL(base).host;
  let url: string | null = base + '/v2/' + repo + '/tags/list?n=' + TAG_LIST_PAGE_SIZE;
  for (let page = 0; page < TAG_LIST_MAX_PAGES && url; page++) {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    const response = await budgetedFetch(url, { headers }, deadline, registry);
    if (response.status === 404) return tags;
    if (!response.ok) {
      console.error('[image-updates] registry ' + registry + ' returned ' + response.status + ' for ' + repo + ' tags');
      throw new RegistryCheckError(
        "Registry " + registry + " failed to list tags for " + repo + ", so this image's update state cannot be checked.",
      );
    }
    const body = (await response.json()) as { tags?: string[] | null };
    for (const tag of body.tags ?? []) tags.push(tag);
    url = nextLink(response.headers.get('link'), registry, baseHost);
  }
  return tags;
}

export interface TagListOptions {
  deadline?: number;
}

/** List tag names for a repository. Empty list means the repo (or its tags) does not exist. */
export async function listRegistryTags(
  registry: string,
  repo: string,
  options: TagListOptions = {},
): Promise<string[]> {
  const endpoints = registryEndpoints(registry);
  const deadline = options.deadline ?? Date.now() + TAG_LIST_BUDGET_MS;
  return endpoints.hubRepo ? fetchDockerHubTags(repo, deadline) : fetchV2Tags(registry, repo, endpoints.base, deadline);
}

/**
 * Current manifest digest a registry serves for one tag, from the
 * `Docker-Content-Digest` header of a HEAD request. null when the tag no
 * longer exists. This is what a floating tag (`latest`) is compared against:
 * a digest mismatch means the tag moved since the local image was pulled.
 */
export async function fetchRemoteManifestDigest(registry: string, repo: string, tag: string): Promise<string | null> {
  const endpoints = registryEndpoints(registry);
  if (endpoints.hubRepo) {
    // Hub's API has no manifest HEAD. The registry endpoint serves it with the same token flow.
    return headManifestDigest(DOCKER_HUB_REGISTRY, registry, repo, tag);
  }
  return headManifestDigest(endpoints.base, registry, repo, tag);
}

async function headManifestDigest(base: string, registry: string, repo: string, tag: string): Promise<string | null> {
  const token = await getPullToken(registry, repo, base);
  const headers: Record<string, string> = { Accept: MANIFEST_ACCEPT_HEADER };
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(base + '/v2/' + repo + '/manifests/' + encodeURIComponent(tag), {
    method: 'HEAD',
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    console.error('[image-updates] registry ' + registry + ' returned ' + response.status + ' for ' + repo + ':' + tag);
    throw new RegistryCheckError(
      'Registry ' + registry + ' failed to read the digest for ' + repo + ':' + tag + ', so the update state is unknown.',
    );
  }
  return response.headers.get('docker-content-digest');
}

const MANIFEST_ACCEPT_HEADER = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export async function checkImageUpdate(
  image: string,
  labels: Record<string, string>,
  imageDigest: string | null = null,
): Promise<ImageUpdateSummary> {
  const base: ImageUpdateSummary = {
    image,
    currentTag: null,
    latestMatchingTag: null,
    latestOverallTag: null,
    updateAvailable: null,
    sourceRepo: sourceRepoFromLabels(labels),
    error: null,
  };

  let ref;
  try {
    ref = parseImageRef(image);
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
  base.currentTag = ref.tag;
  if (!ref.tag) return base;

  if (!isRegistryAllowed(ref.registry)) {
    return {
      ...base,
      error:
        'Registry ' + ref.registry + ' is not on the allowed registries list. ' +
        'Add it to IMAGE_UPDATE_EXTRA_REGISTRIES to check updates for its images.',
    };
  }

  const constraint = constraintFromTag(ref.tag);
  if (!constraint) {
    // Floating tag: the tag itself is the update channel, so an update is a
    // moved manifest digest, not a newer version number. Without the local
    // digest (locally built image, or pre-039 inventory row) the check is
    // inconclusive rather than "up to date".
    if (!imageDigest) return base;
    try {
      const remoteDigest = await fetchRemoteManifestDigest(ref.registry, ref.repo, ref.tag);
      return { ...base, updateAvailable: remoteDigest ? remoteDigest !== imageDigest : null };
    } catch (err) {
      return { ...base, error: err instanceof Error ? err.message : String(err) };
    }
  }

  let tags: string[];
  try {
    tags = await listRegistryTags(ref.registry, ref.repo);
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }

  const latestMatching = newestTagMatchingConstraint(tags, constraint);
  const latestOverall = newestVersionTag(tags);
  const current = parseVersionTag(ref.tag);
  if (!current) return base;
  // No tag matching the constraint means there is nothing to update to, not
  // that the check is inconclusive.
  const updateAvailable = latestMatching ? compareVersions(latestMatching, current) > 0 : false;

  return {
    ...base,
    latestMatchingTag: latestMatching?.raw ?? null,
    latestOverallTag: latestOverall?.raw ?? null,
    updateAvailable,
  };
}

/** GitHub `owner/repo` from the OCI source label, github.com only. */
export function sourceRepoFromLabels(labels: Record<string, string>): string | null {
  const source = labels['org.opencontainers.image.source'];
  if (!source) return null;
  const match = source.match(/^https:\/\/github\.com\/([^/]+)\/([^/#?]+)/);
  if (!match) return null;
  const repo = match[2].replace(/\.git$/, '');
  return match[1] + '/' + repo;
}
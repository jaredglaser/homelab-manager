import { parseImageRef } from './image-ref';
import {
  compareVersions,
  constraintFromTag,
  newestTagMatchingConstraint,
  newestVersionTag,
  parseVersionTag,
} from './version';
import type { ImageUpdateSummary } from '@/types/image-updates';

const REQUEST_TIMEOUT_MS = 10_000;
const TAG_LIST_PAGE_SIZE = 1000;
const DOCKER_HUB_API = 'https://hub.docker.com/v2';

/** Registry tag listing failed; the message is shown in the UI as the check error. */
export class RegistryCheckError extends Error {}

interface RegistryEndpoints {
  base: string;
  /** Docker Hub tags live on the Hub API, not the registry v2 API. */
  hubRepo?: boolean;
}

function registryEndpoints(registry: string): RegistryEndpoints {
  if (registry === 'docker.io') return { base: DOCKER_HUB_API, hubRepo: true };
  return { base: `https://${registry}` };
}

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, TokenCacheEntry>();

/**
 * Docker Registry v2 token flow for anonymous pull access. Registries that
 * serve public images without a token (or with a 200 on the first probe) never
 * reach the token request. Tokens are cached per registry+repo until shortly
 * before their `exp` claim.
 */
async function getPullToken(registry: string, repo: string, base: string): Promise<string | null> {
  const cacheKey = `${registry}|${repo}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

  const probe = await fetch(`${base}/v2/`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (probe.ok) return null;
  const authHeader = probe.headers.get('www-authenticate');
  const realm = authHeader?.match(/realm="([^"]+)"/)?.[1];
  if (probe.status !== 401 || !realm) {
    throw new RegistryCheckError(`registry ${registry} did not offer anonymous pull access`);
  }
  const service = authHeader?.match(/service="([^"]+)"/)?.[1];
  const scope = `repository:${repo}:pull`;
  // The realm comes from the registry's own response header, but the registry
  // name came from a user-supplied image ref: a realm pointing anywhere else
  // would turn a typo'd image into an arbitrary server-side GET.
  const realmUrl = new URL(realm);
  if (realmUrl.protocol !== 'https:' || realmUrl.host !== registry) {
    throw new RegistryCheckError(`registry ${registry} pointed its token endpoint at an unexpected host`);
  }
  const tokenUrl = realmUrl;
  if (service) tokenUrl.searchParams.set('service', service);
  tokenUrl.searchParams.set('scope', scope);
  const tokenResponse = await fetch(tokenUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!tokenResponse.ok) {
    throw new RegistryCheckError(`registry ${registry} token endpoint returned ${tokenResponse.status}`);
  }
  const body = (await tokenResponse.json()) as { token?: string; access_token?: string };
  const token = body.token ?? body.access_token;
  if (!token) throw new RegistryCheckError(`registry ${registry} token response carried no token`);
  const exp = decodeJwtExp(token);
  tokenCache.set(cacheKey, { token, expiresAt: exp ?? Date.now() + 5 * 60_000 });
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

async function fetchDockerHubTags(repo: string): Promise<string[]> {
  const tags: string[] = [];
  let url: string | null = `${DOCKER_HUB_API}/repositories/${repo}/tags?page_size=100`;
  // Cap pages so a pathological repo cannot hold the check open: 10 pages of
  // 100 tags is far past where the newest matching tag can hide.
  for (let page = 0; page < 10 && url; page++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (response.status === 404) return tags;
    if (!response.ok) throw new RegistryCheckError(`Docker Hub returned ${response.status} for ${repo}`);
    const body = (await response.json()) as TagPage;
    for (const result of body.results ?? []) {
      if (result.name) tags.push(result.name);
    }
    url = body.next ?? null;
  }
  return tags;
}

function nextLink(header: string | null, base: string): string | null {
  const match = header?.match(/<([^>]+)>\s*;\s*rel="next"/) ?? header?.match(/<([^>]+)>/);
  return match ? new URL(match[1], base).toString() : null;
}

async function fetchV2Tags(registry: string, repo: string, base: string): Promise<string[]> {
  const token = await getPullToken(registry, repo, base);
  const tags: string[] = [];
  let url: string | null = `${base}/v2/${repo}/tags/list?n=${TAG_LIST_PAGE_SIZE}`;
  // Same page cap as the Hub path; some registries (Quay) cap `n` well below
  // TAG_LIST_PAGE_SIZE and paginate the rest through Link headers.
  for (let page = 0; page < 10 && url; page++) {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (response.status === 404) return tags;
    if (!response.ok) throw new RegistryCheckError(`registry ${registry} returned ${response.status} for ${repo} tags`);
    const body = (await response.json()) as { tags?: string[] | null };
    for (const tag of body.tags ?? []) tags.push(tag);
    url = nextLink(response.headers.get('link'), base);
  }
  return tags;
}

/** List tag names for a repository. Empty list means the repo (or its tags) does not exist. */
export async function listRegistryTags(registry: string, repo: string): Promise<string[]> {
  const endpoints = registryEndpoints(registry);
  return endpoints.hubRepo ? fetchDockerHubTags(repo) : fetchV2Tags(registry, repo, endpoints.base);
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
    // Hub's API has no manifest HEAD; the registry endpoint serves it with the same token flow.
    return headManifestDigest('https://registry-1.docker.io', registry, repo, tag);
  }
  return headManifestDigest(endpoints.base, registry, repo, tag);
}

async function headManifestDigest(base: string, registry: string, repo: string, tag: string): Promise<string | null> {
  const token = await getPullToken(registry, repo, base);
  const headers: Record<string, string> = { Accept: MANIFEST_ACCEPT_HEADER };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${base}/v2/${repo}/manifests/${encodeURIComponent(tag)}`, {
    method: 'HEAD',
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new RegistryCheckError(`registry ${registry} returned ${response.status} for ${repo}:${tag}`);
  return response.headers.get('docker-content-digest');
}

const MANIFEST_ACCEPT_HEADER = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/**
 * Compare a running tag against the registry's tag list and produce the update
 * summary for one image. Registry failures produce `error` rather than throwing,
 * so one unreachable registry cannot blank the whole panel.
 */
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
  return `${match[1]}/${repo}`;
}

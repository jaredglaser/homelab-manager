import { AGENT_SOURCE_HASH_LABEL } from '@homelab-manager/agent/types';

// Any failure resolves to null so the caller fails the update instead of degrading to the floating tag.
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

interface ImageRefParts {
  registry: string;
  repository: string;
  tag: string;
}

// A repository path contains slashes, so the tag separator is the last colon only.
function splitImageRef(imageRef: string): ImageRefParts | null {
  const tagSeparator = imageRef.lastIndexOf(':');
  const registryEnd = imageRef.indexOf('/');
  if (registryEnd < 1 || tagSeparator < registryEnd) return null;
  const repository = imageRef.slice(0, tagSeparator);
  return {
    registry: repository.slice(0, registryEnd),
    repository: repository.slice(registryEnd + 1),
    tag: imageRef.slice(tagSeparator + 1),
  };
}

function parseBearerChallenge(header: string | null): { realm: string; service?: string; scope?: string } | null {
  if (!header?.startsWith('Bearer ')) return null;
  const params: Record<string, string> = {};
  // Challenge params are comma-separated key="value" pairs, not a query string.
  for (const pair of header.slice('Bearer '.length).split(',')) {
    const separator = pair.indexOf('=');
    if (separator < 1) continue;
    params[pair.slice(0, separator).trim()] = pair.slice(separator + 1).trim().replace(/^"/, '').replace(/"$/, '');
  }
  if (!params.realm) return null;
  return {
    realm: params.realm,
    service: params.service,
    scope: params.scope,
  };
}

async function fetchAnonymousToken(response: Response, parts: ImageRefParts): Promise<string | null> {
  // Public GHCR images still gate the manifest endpoint behind a Bearer challenge, so retry once with an anonymous pull token.
  const challenge = parseBearerChallenge(response.headers.get('www-authenticate'));
  if (!challenge) return null;
  const tokenUrl = new URL(challenge.realm);
  // Only follow the challenge to the registry that issued it: anything else is a redirect to attacker-controlled territory.
  if (tokenUrl.protocol !== 'https:' || tokenUrl.host !== parts.registry) return null;
  if (challenge.service) tokenUrl.searchParams.set('service', challenge.service);
  if (challenge.scope) tokenUrl.searchParams.set('scope', challenge.scope);
  const tokenResponse = await fetch(tokenUrl, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  if (!tokenResponse.ok) return null;
  const payload = (await tokenResponse.json().catch(() => null)) as { token?: unknown } | null;
  return typeof payload?.token === 'string' ? payload.token : null;
}

interface RegistrySession {
  parts: ImageRefParts;
  token?: string;
}

async function registryGet(session: RegistrySession, path: string, accept: string): Promise<Response | null> {
  const request = () => {
    const headers: Record<string, string> = { Accept: accept };
    if (session.token) headers.Authorization = 'Bearer ' + session.token;
    // redirect: 'manual' keeps a hostile registry from bouncing an authenticated request elsewhere.
    return fetch(`https://${session.parts.registry}/v2/${session.parts.repository}/${path}`, {
      headers,
      redirect: 'manual',
      // A hung registry connection must not stall the worker sweep past its next interval.
      signal: AbortSignal.timeout(5000),
    });
  };
  const response = await request();
  if (response.status !== 401) return response;
  if (session.token) return null;
  const token = await fetchAnonymousToken(response, session.parts);
  if (!token) return null;
  session.token = token;
  return request();
}

async function readIndex(session: RegistrySession): Promise<{ digest: string; body: unknown } | null> {
  const response = await registryGet(session, `manifests/${session.parts.tag}`, MANIFEST_ACCEPT);
  if (!response || !response.ok) return null;
  const body: unknown = await response.json().catch(() => null);
  const headerDigest = response.headers.get('docker-content-digest');
  if (headerDigest) return SHA256_DIGEST_PATTERN.test(headerDigest) ? { digest: headerDigest, body } : null;
  const bodyDigest = (body as { digest?: unknown } | null)?.digest;
  return typeof bodyDigest === 'string' && SHA256_DIGEST_PATTERN.test(bodyDigest) ? { digest: bodyDigest, body } : null;
}

export async function resolveAgentImageDigest(imageRef: string): Promise<string | null> {
  const parts = splitImageRef(imageRef);
  if (!parts) return null;
  try {
    return (await readIndex({ parts }))?.digest ?? null;
  } catch {
    return null;
  }
}

export interface AgentImageRelease {
  digest: string;
  /** The image's AGENT_SOURCE_HASH_LABEL, or null when it has none or it could not be read. */
  sourceHash: string | null;
}

const SOURCE_HASH_PATTERN = /^[0-9a-f]{64}$/;

interface ManifestEntry {
  digest?: unknown;
  platform?: { os?: unknown };
}

/** Every platform of one build carries the same label, so any real platform will do. Attestations list os "unknown". */
function platformManifestDigest(index: unknown, indexDigest: string): string | null {
  const manifests = (index as { manifests?: unknown } | null)?.manifests;
  if (!Array.isArray(manifests)) return indexDigest;
  const entry = (manifests as ManifestEntry[]).find((m) => m.platform?.os !== 'unknown');
  return typeof entry?.digest === 'string' && SHA256_DIGEST_PATTERN.test(entry.digest) ? entry.digest : null;
}

async function fetchConfigBlob(session: RegistrySession, configDigest: string): Promise<Uint8Array | null> {
  let response = await registryGet(session, `blobs/${configDigest}`, '*/*');
  if (!response) return null;
  if (response.status >= 300 && response.status < 400) {
    // GHCR serves blobs from a storage host. The token stays behind, and the digest check below vouches for the bytes.
    const location = response.headers.get('location');
    if (!location) return null;
    const target = new URL(location, `https://${session.parts.registry}`);
    if (target.protocol !== 'https:') return null;
    response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  }
  if (!response.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const actual = 'sha256:' + Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
  return actual === configDigest ? bytes : null;
}

async function readSourceHash(session: RegistrySession, index: unknown, indexDigest: string): Promise<string | null | undefined> {
  const manifestDigest = platformManifestDigest(index, indexDigest);
  if (!manifestDigest) return undefined;
  let manifest: unknown = index;
  if (manifestDigest !== indexDigest) {
    const response = await registryGet(session, `manifests/${manifestDigest}`, MANIFEST_ACCEPT);
    if (!response || !response.ok) return undefined;
    manifest = await response.json().catch(() => null);
  }
  const configDigest = (manifest as { config?: { digest?: unknown } } | null)?.config?.digest;
  if (typeof configDigest !== 'string' || !SHA256_DIGEST_PATTERN.test(configDigest)) return undefined;
  const blob = await fetchConfigBlob(session, configDigest);
  if (!blob) return undefined;
  const config = JSON.parse(new TextDecoder().decode(blob)) as { config?: { Labels?: Record<string, unknown> | null } };
  const label = config.config?.Labels?.[AGENT_SOURCE_HASH_LABEL];
  return typeof label === 'string' && SOURCE_HASH_PATTERN.test(label) ? label : null;
}

// An index digest names immutable content, so its label never changes. Bounded because `main` moves on every merge.
const sourceHashByDigest = new Map<string, string | null>();
const MAX_CACHED_DIGESTS = 32;

/** Resolves the image's digest and, best-effort, its source hash label. Null only when the digest itself is unresolvable. */
export async function resolveAgentImageRelease(imageRef: string): Promise<AgentImageRelease | null> {
  const parts = splitImageRef(imageRef);
  if (!parts) return null;
  const session: RegistrySession = { parts };
  let index: { digest: string; body: unknown } | null;
  try {
    index = await readIndex(session);
  } catch {
    return null;
  }
  if (!index) return null;
  const cached = sourceHashByDigest.get(index.digest);
  if (cached !== undefined) return { digest: index.digest, sourceHash: cached };
  let sourceHash: string | null | undefined;
  try {
    sourceHash = await readSourceHash(session, index.body, index.digest);
  } catch {
    sourceHash = undefined;
  }
  if (sourceHash !== undefined) {
    if (sourceHashByDigest.size >= MAX_CACHED_DIGESTS) sourceHashByDigest.clear();
    sourceHashByDigest.set(index.digest, sourceHash);
  }
  return { digest: index.digest, sourceHash: sourceHash ?? null };
}

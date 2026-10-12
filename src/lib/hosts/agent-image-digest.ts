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

async function fetchManifest(parts: ImageRefParts, token?: string): Promise<Response | null> {
  const headers: Record<string, string> = { Accept: MANIFEST_ACCEPT };
  if (token) headers.Authorization = 'Bearer ' + token;
  // redirect: 'manual' keeps a hostile registry from bouncing an authenticated request elsewhere.
  const response = await fetch(`https://${parts.registry}/v2/${parts.repository}/manifests/${parts.tag}`, {
    headers,
    redirect: 'manual',
    // A hung registry connection must not stall the worker sweep past its next interval.
    signal: AbortSignal.timeout(5000),
  });
  if (response.status !== 401) return response;
  // Public GHCR images still gate the manifest endpoint behind a Bearer challenge, so retry once with an anonymous pull token.
  const challenge = parseBearerChallenge(response.headers.get('www-authenticate'));
  if (!challenge || token) return null;
  const tokenUrl = new URL(challenge.realm);
  // Only follow the challenge to the registry that issued it: anything else is a redirect to attacker-controlled territory.
  if (tokenUrl.protocol !== 'https:' || tokenUrl.host !== parts.registry) return null;
  if (challenge.service) tokenUrl.searchParams.set('service', challenge.service);
  if (challenge.scope) tokenUrl.searchParams.set('scope', challenge.scope);
  const tokenResponse = await fetch(tokenUrl, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  if (!tokenResponse.ok) return null;
  const payload = (await tokenResponse.json().catch(() => null)) as { token?: unknown } | null;
  if (typeof payload?.token !== 'string') return null;
  return fetchManifest(parts, payload.token);
}

export async function resolveAgentImageDigest(imageRef: string): Promise<string | null> {
  const parts = splitImageRef(imageRef);
  if (!parts) return null;
  try {
    const response = await fetchManifest(parts);
    if (!response || !response.ok) return null;
    const headerDigest = response.headers.get('docker-content-digest');
    if (headerDigest) return SHA256_DIGEST_PATTERN.test(headerDigest) ? headerDigest : null;
    const manifest = (await response.json().catch(() => null)) as { digest?: unknown } | null;
    return typeof manifest?.digest === 'string' && SHA256_DIGEST_PATTERN.test(manifest.digest)
      ? manifest.digest
      : null;
  } catch {
    return null;
  }
}

import type Dockerode from 'dockerode';

export interface AgentImageInfo {
  image: string | null;
  tag: string | null;
}

const DOCKER_TAG_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;

/**
 * A colon can belong to a registry port (`localhost:5000/agent`), an untagged reference means
 * `latest` as Docker resolves it, and a digest-only pin has no tag to report.
 */
export function parseImageTag(reference: string): string | null {
  const withoutDigest = reference.trim().split('@')[0];
  if (!withoutDigest) return null;

  const lastColon = withoutDigest.lastIndexOf(':');
  const lastSlash = withoutDigest.lastIndexOf('/');
  if (lastColon === -1 || lastColon < lastSlash) {
    return reference.includes('@') ? null : 'latest';
  }

  const tag = withoutDigest.slice(lastColon + 1);
  return DOCKER_TAG_PATTERN.test(tag) ? tag : null;
}

const UNRESOLVED: AgentImageInfo = { image: null, tag: null };
// Dockerode sets no request timeout. Without this a socket-proxy that accepts the
// connection and never answers leaves the resolver's in-flight promise pending forever,
// and every later /info awaits that same promise instead of retrying.
const INSPECT_TIMEOUT_MS = 5000;

async function inspectWithTimeout(docker: Dockerode, containerName: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      docker.getContainer(containerName).inspect(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`inspect timed out after ${INSPECT_TIMEOUT_MS}ms`)),
          INSPECT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lazy, not resolved at startup: Dockerode sets no request timeout, so a black-holed
 * DOCKER_HOST would stall the process before `Bun.serve` binds, and a cold start races
 * socket-proxy. Failures retry on the next call; only a success is cached.
 */
export function createAgentImageResolver(
  docker: Dockerode | null,
  containerName: string,
  envImage: string | undefined,
): () => Promise<AgentImageInfo> {
  let resolved: AgentImageInfo | null = null;
  let inFlight: Promise<AgentImageInfo> | null = null;

  return async () => {
    if (resolved) return resolved;
    inFlight ??= resolveAgentImage(docker, containerName, envImage).finally(() => {
      inFlight = null;
    });
    const result = await inFlight;
    if (result.image !== null) resolved = result;
    return result;
  };
}

/** `AGENT_IMAGE` wins: it is the only source on a ZFS-only host, which has no Docker socket. */
export async function resolveAgentImage(
  docker: Dockerode | null,
  containerName: string,
  envImage: string | undefined,
): Promise<AgentImageInfo> {
  const fromEnv = envImage?.trim();
  if (fromEnv) return { image: fromEnv, tag: parseImageTag(fromEnv) };

  if (!docker) return UNRESOLVED;

  try {
    const info = await inspectWithTimeout(docker, containerName);
    const image = info.Config?.Image?.trim();
    if (!image) return UNRESOLVED;
    return { image, tag: parseImageTag(image) };
  } catch (error) {
    console.error(
      `Could not determine agent image from container '${containerName}':`,
      error instanceof Error ? error.message : error,
    );
    return UNRESOLVED;
  }
}

// Resolved fresh on every /info, never cached: the manager compares this digest
// against the registry digest of its own agent image to flag an update, and a
// cached value would freeze the comparison at whatever the first probe saw.
export interface RunningAgentReference {
  repo: string;
  digest: string;
}

export async function resolveRunningAgentReference(
  docker: Dockerode | null,
  containerName: string,
): Promise<RunningAgentReference | null> {
  if (!docker) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const info = await inspectWithTimeout(docker, containerName);
    try {
      // Dockerode sets no request timeout, so the image inspect gets the same bounded race as the container inspect above.
      const imageInfo = await Promise.race([
        docker.getImage(info.Image).inspect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`image inspect timed out after ${INSPECT_TIMEOUT_MS}ms`)), INSPECT_TIMEOUT_MS);
        }),
      ]);
      const repoDigest = imageInfo.RepoDigests?.[0];
      if (!repoDigest || !repoDigest.includes('@')) return null;
      const at = repoDigest.indexOf('@');
      return { repo: repoDigest.slice(0, at), digest: repoDigest.slice(at + 1) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (error) {
    console.error(
      `Could not determine the running agent image reference from container '${containerName}':`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

export async function resolveRunningAgentDigest(
  docker: Dockerode | null,
  containerName: string,
): Promise<string | null> {
  const reference = await resolveRunningAgentReference(docker, containerName);
  return reference ? reference.digest : null;
}

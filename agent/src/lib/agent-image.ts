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
    const info = await docker.getContainer(containerName).inspect();
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

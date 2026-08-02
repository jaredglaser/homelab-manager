import type Dockerode from 'dockerode';

export interface AgentImageInfo {
  /** Full image reference the agent container runs, or null when it cannot be determined. */
  image: string | null;
  /** Tag portion of that reference, or null when the reference carries no usable tag. */
  tag: string | null;
}

const DOCKER_TAG_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;

/**
 * Extract the tag from a Docker image reference.
 *
 * Handles the three shapes that reach us: a registry host with a port
 * (`localhost:5000/agent`, where the colon is not a tag separator), a digest
 * pin (`agent:dev@sha256:...`), and an untagged reference, which Docker
 * resolves to `latest`. Returns null for a digest-only reference, which pins a
 * build with no tag to report.
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

/**
 * Resolve the image this agent is running.
 *
 * `AGENT_IMAGE` wins when set: the generated agent stack passes it through from
 * the same compose variable that pins the container, and it is the only source
 * available on a ZFS-only host with no Docker socket. Otherwise the agent
 * inspects its own container, which is what lets a host enrolled before this
 * existed start reporting a tag as soon as its agent updates.
 */
export async function resolveAgentImage(
  docker: Dockerode | null,
  containerName: string,
  envImage: string | undefined,
): Promise<AgentImageInfo> {
  const fromEnv = envImage?.trim();
  if (fromEnv) return { image: fromEnv, tag: parseImageTag(fromEnv) };

  if (!docker) return { image: null, tag: null };

  try {
    const info = await docker.getContainer(containerName).inspect();
    const image = info.Config?.Image?.trim();
    if (!image) return { image: null, tag: null };
    return { image, tag: parseImageTag(image) };
  } catch (error) {
    console.error(
      `Could not determine agent image from container '${containerName}':`,
      error instanceof Error ? error.message : error,
    );
    return { image: null, tag: null };
  }
}

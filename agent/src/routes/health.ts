import type Dockerode from 'dockerode';
import type { AgentImageInfo } from '../lib/agent-image';
import type { ZfsCapabilities } from '../lib/zfs-capabilities';
import pkg from '../../package.json';

const { version } = pkg;

interface DockerCapability {
  available: boolean;
  version?: string;
  apiVersion?: string;
}

/**
 * Query the Docker daemon for its version info and return a capability object.
 */
async function getDockerCapability(
  docker: Dockerode
): Promise<DockerCapability> {
  try {
    const dockerVersion = await docker.version();
    return {
      available: true,
      version: dockerVersion.Version,
      apiVersion: dockerVersion.ApiVersion,
    };
  } catch {
    return { available: false };
  }
}

async function checkHealthy(
  docker: Dockerode | null,
  zfsCapabilities?: ZfsCapabilities
): Promise<{ dockerCapability: DockerCapability; zfsAvailable: boolean; isHealthy: boolean }> {
  const dockerCapability = docker
    ? await getDockerCapability(docker)
    : { available: false };
  const zfsAvailable = zfsCapabilities?.available ?? false;
  return { dockerCapability, zfsAvailable, isHealthy: dockerCapability.available || zfsAvailable };
}

/**
 * Liveness check for the unauthenticated /health endpoint. Returns only the
 * status field: this endpoint bypasses auth, so it must not expose version or
 * capability detail to unauthenticated callers. Use /info (authenticated) for
 * version and capability data.
 *
 * @param docker - Dockerode client, or null when Docker is not configured
 * @param zfsCapabilities - Pre-detected ZFS capabilities (detected once at startup)
 * @returns 200 with status healthy, or 503 with status unhealthy
 */
export async function handleHealth(
  docker: Dockerode | null,
  zfsCapabilities?: ZfsCapabilities
): Promise<Response> {
  const { isHealthy } = await checkHealthy(docker, zfsCapabilities);
  return Response.json(
    { status: isHealthy ? 'healthy' : 'unhealthy' },
    { status: isHealthy ? 200 : 503 }
  );
}

/**
 * Detailed agent info for the authenticated /info endpoint: agent version plus
 * Docker and ZFS capability detail.
 *
 * @param docker - Dockerode client, or null when Docker is not configured
 * @param zfsCapabilities - Pre-detected ZFS capabilities (detected once at startup)
 * @param resolveImage - Lazy resolver for this agent's image; null fields mean undetermined
 * @returns An HTTP Response whose JSON body includes status, agentVersion, agent image, and capabilities
 */
export async function handleInfo(
  docker: Dockerode | null,
  zfsCapabilities?: ZfsCapabilities,
  resolveImage?: () => Promise<AgentImageInfo>
): Promise<Response> {
  const { dockerCapability, zfsAvailable, isHealthy } = await checkHealthy(docker, zfsCapabilities);
  const agentImage = await resolveImage?.();

  return Response.json(
    {
      status: isHealthy ? 'healthy' : 'unhealthy',
      agentVersion: version,
      agentImage: agentImage?.image ?? null,
      agentImageTag: agentImage?.tag ?? null,
      capabilities: {
        docker: dockerCapability,
        fleetLogs: dockerCapability.available,
        zfs: zfsAvailable
          ? {
              available: true,
              version: zfsCapabilities!.version,
              tier: zfsCapabilities!.tier,
              permissions: zfsCapabilities!.permissions,
            }
          : { available: false },
      },
    },
    { status: isHealthy ? 200 : 503 }
  );
}

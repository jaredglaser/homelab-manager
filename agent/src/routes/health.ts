import type Dockerode from 'dockerode';
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

/**
 * Perform a health check and produce an HTTP JSON Response describing agent capabilities.
 *
 * @param docker - Dockerode client, or null when Docker is not configured
 * @param zfsCapabilities - Pre-detected ZFS capabilities (detected once at startup)
 * @returns An HTTP Response whose JSON body includes status, agentVersion, and capabilities
 */
export async function handleHealth(
  docker: Dockerode | null,
  zfsCapabilities?: ZfsCapabilities
): Promise<Response> {
  const dockerCapability = docker
    ? await getDockerCapability(docker)
    : { available: false };

  const zfsAvailable = zfsCapabilities?.available ?? false;
  const isHealthy = dockerCapability.available || zfsAvailable;

  return Response.json(
    {
      status: isHealthy ? 'healthy' : 'unhealthy',
      agentVersion: version,
      capabilities: {
        docker: dockerCapability,
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

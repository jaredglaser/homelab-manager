import type Dockerode from 'dockerode';
import pkg from '../../package.json';

const { version } = pkg;

/**
 * Perform a health check against the Docker daemon and produce an HTTP JSON Response describing agent and Docker status.
 *
 * @param docker - Dockerode client used to query the Docker daemon
 * @returns An HTTP Response whose JSON body is:
 * - On success (HTTP 200): `{ status: "healthy", agentVersion, docker: { version, apiVersion } }`
 * - On failure (HTTP 503): `{ status: "unhealthy", agentVersion, error: "docker_unreachable" }`
 */
export async function handleHealth(docker: Dockerode): Promise<Response> {
  try {
    const dockerVersion = await docker.version();
    return Response.json(
      {
        status: 'healthy',
        agentVersion: version,
        docker: {
          version: dockerVersion.Version,
          apiVersion: dockerVersion.ApiVersion,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Health check failed:', error);
    return Response.json(
      {
        status: 'unhealthy',
        agentVersion: version,
        error: 'docker_unreachable',
      },
      { status: 503 }
    );
  }
}

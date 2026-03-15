import type Dockerode from 'dockerode';
import pkg from '../../package.json';

const { version } = pkg;

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
      },
      { status: 503 }
    );
  }
}

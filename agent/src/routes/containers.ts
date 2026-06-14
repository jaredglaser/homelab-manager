import type Dockerode from 'dockerode';

type DockerodeError = { statusCode?: number; message?: string };

function isAlreadyInState(err: DockerodeError): boolean {
  const msg = err.message?.toLowerCase() ?? '';
  return err.statusCode === 304 || msg.includes('already') || msg.includes('not running');
}

async function controlContainer(
  docker: Dockerode,
  containerId: string,
  action: 'start' | 'stop' | 'restart',
): Promise<Response> {
  try {
    const container = docker.getContainer(containerId);
    if (action === 'start') await container.start();
    else if (action === 'stop') await container.stop();
    else await container.restart();
    return Response.json({ status: 'success' });
  } catch (err) {
    const e = err as DockerodeError;
    if (e.statusCode === 404) {
      return Response.json({ error: `Container not found: ${containerId}` }, { status: 404 });
    }
    if (isAlreadyInState(e)) {
      return Response.json({ error: e.message ?? `Container already in target state` }, { status: 409 });
    }
    console.error(`[containers] ${action} failed for ${containerId}:`, err);
    return Response.json({ error: e.message ?? 'Internal error' }, { status: 500 });
  }
}

export function handleContainerStart(docker: Dockerode, containerId: string, _request: Request): Promise<Response> {
  return controlContainer(docker, containerId, 'start');
}

export function handleContainerStop(docker: Dockerode, containerId: string, _request: Request): Promise<Response> {
  return controlContainer(docker, containerId, 'stop');
}

export function handleContainerRestart(docker: Dockerode, containerId: string, _request: Request): Promise<Response> {
  return controlContainer(docker, containerId, 'restart');
}

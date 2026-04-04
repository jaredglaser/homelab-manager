import type Dockerode from 'dockerode';

/**
 * Handle a self-update request for the agent container.
 *
 * Returns 202 Accepted immediately, then asynchronously pulls the current image,
 * recreates the container with the same configuration, and starts it. This means
 * the agent process may be replaced mid-operation after the response has been sent.
 *
 * @param docker - Dockerode client, or null if Docker capability is not enabled
 * @param containerName - Name of the agent container to update
 * @returns 503 if Docker is not enabled, 202 if the update sequence was started
 */
export async function handleAgentUpdate(docker: Dockerode | null, containerName: string): Promise<Response> {
  if (!docker) {
    return Response.json({ error: 'Docker capability not enabled' }, { status: 503 });
  }

  const response = new Response(null, { status: 202 });

  (async () => {
    try {
      const inspectData = await docker.getContainer(containerName).inspect();
      const image: string = inspectData.Image;

      await new Promise<void>((resolve, reject) => {
        docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) { reject(err); return; }
          docker.modem.followProgress(stream, (err2: Error | null) => {
            if (err2) reject(err2); else resolve();
          });
        });
      });

      await docker.getContainer(containerName).stop();
      await docker.getContainer(containerName).remove();

      const newContainer = await docker.createContainer({
        name: containerName,
        Image: image,
        Cmd: inspectData.Config.Cmd ?? undefined,
        Entrypoint: inspectData.Config.Entrypoint ?? undefined,
        Env: inspectData.Config.Env ?? [],
        ExposedPorts: inspectData.Config.ExposedPorts,
        Labels: inspectData.Config.Labels ?? {},
        HostConfig: inspectData.HostConfig,
      });

      await newContainer.start();

      const networkMode = inspectData.HostConfig.NetworkMode ?? '';
      const skipNetwork = networkMode === 'host' || networkMode === 'none' || networkMode.startsWith('container:');
      if (!skipNetwork) {
        const networks = inspectData.NetworkSettings.Networks as Record<string, unknown>;
        for (const networkName of Object.keys(networks)) {
          if (networkName === networkMode) continue;
          await docker.getNetwork(networkName).connect({ Container: newContainer.id });
        }
      }
    } catch (error) {
      console.error('Agent self-update failed:', error);
    }
  })();

  return response;
}

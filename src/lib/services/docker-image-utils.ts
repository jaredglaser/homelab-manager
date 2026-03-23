import type Dockerode from 'dockerode';

/**
 * Pull a Docker image and wait for completion.
 * Shared between AgentProvisioningService and AgentUpdateService.
 */
export async function pullImage(docker: Dockerode, image: string): Promise<void> {
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

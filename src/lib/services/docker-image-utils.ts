import type Dockerode from 'dockerode';

const IMAGE_PULL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Pull a Docker image and wait for completion.
 * Shared between AgentProvisioningService and AgentUpdateService.
 * Rejects if the pull takes longer than IMAGE_PULL_TIMEOUT_MS.
 */
export async function pullImage(docker: Dockerode, image: string): Promise<void> {
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if ('destroy' in stream && typeof stream.destroy === 'function') stream.destroy();
      reject(new Error(`Image pull timed out after ${IMAGE_PULL_TIMEOUT_MS / 1000}s: ${image}`));
    }, IMAGE_PULL_TIMEOUT_MS);

    docker.modem.followProgress(stream, (err: Error | null) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
}

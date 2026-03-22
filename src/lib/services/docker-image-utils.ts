import type Dockerode from 'dockerode';

const IMAGE_PULL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Pull a Docker image and wait for completion.
 * Used for pulling agent images during host management operations.
 * Rejects if the pull takes longer than IMAGE_PULL_TIMEOUT_MS.
 */
export async function pullImage(docker: Dockerode, image: string, timeoutMs: number = IMAGE_PULL_TIMEOUT_MS): Promise<void> {
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if ('destroy' in stream && typeof stream.destroy === 'function') stream.destroy();
      reject(new Error(`Image pull timed out after ${timeoutMs / 1000}s: ${image}`));
    }, timeoutMs);

    docker.modem.followProgress(stream, (err: Error | null) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
}

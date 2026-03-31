import { describe, it, expect, mock } from 'bun:test';
import { pullImage } from '../docker-image-utils';

function createMockDocker(error?: Error) {
  return {
    pull: async () => 'mock-stream',
    modem: {
      followProgress: (_stream: unknown, cb: (err: Error | null) => void) => {
        cb(error ?? null);
      },
    },
  } as any;
}

describe('pullImage', () => {
  it('resolves when pull succeeds', async () => {
    const docker = createMockDocker();
    await expect(pullImage(docker, 'test-image:latest')).resolves.toBeUndefined();
  });

  it('rejects when followProgress returns an error', async () => {
    const docker = createMockDocker(new Error('pull failed: unauthorized'));
    await expect(pullImage(docker, 'test-image:latest')).rejects.toThrow('pull failed: unauthorized');
  });

  it('passes the image name to docker.pull', async () => {
    let pulledImage = '';
    const docker = {
      pull: async (image: string) => { pulledImage = image; return 'mock-stream'; },
      modem: { followProgress: (_s: unknown, cb: (err: null) => void) => { cb(null); } },
    } as any;
    await pullImage(docker, 'ghcr.io/homelab-manager/agent:latest');
    expect(pulledImage).toBe('ghcr.io/homelab-manager/agent:latest');
  });

  it('rejects when docker.pull throws', async () => {
    const docker = {
      pull: async () => { throw new Error('connection refused'); },
      modem: { followProgress: () => {} },
    } as any;
    await expect(pullImage(docker, 'bad-image:latest')).rejects.toThrow('connection refused');
  });

  it('rejects with timeout error and destroys the stream when pull exceeds timeoutMs', async () => {
    const destroy = mock(() => {});
    const stream = { destroy };
    const docker = {
      pull: async () => stream,
      modem: {
        // Never call the callback — simulates a stalled pull
        followProgress: () => {},
      },
    } as any;

    await expect(pullImage(docker, 'slow-image:latest', 10)).rejects.toThrow(
      'Image pull timed out after 0.01s: slow-image:latest',
    );
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

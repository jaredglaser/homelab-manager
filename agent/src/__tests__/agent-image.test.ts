import { describe, expect, test, mock, beforeAll } from 'bun:test';
import { createAgentImageResolver, parseImageTag, resolveAgentImage } from '../lib/agent-image';

beforeAll(() => {
  console.error = mock(() => {});
});

describe('parseImageTag', () => {
  test.each([
    ['ghcr.io/jaredglaser/homelab-manager-agent:dev', 'dev'],
    ['ghcr.io/jaredglaser/homelab-manager-agent:latest', 'latest'],
    ['homelab-manager-agent:a1b2c3d', 'a1b2c3d'],
    ['agent:v1.2.3-rc.1', 'v1.2.3-rc.1'],
  ])('reads the tag out of %s', (reference, expected) => {
    expect(parseImageTag(reference)).toBe(expected);
  });

  test.each([
    ['ghcr.io/jaredglaser/homelab-manager-agent', 'no tag at all'],
    ['agent', 'a bare name'],
    ['localhost:5000/agent', 'a registry port and no tag'],
  ])('treats %s (%s) as latest, matching Docker', (reference) => {
    expect(parseImageTag(reference)).toBe('latest');
  });

  test('keeps the tag when a digest is pinned alongside it', () => {
    expect(parseImageTag('ghcr.io/x/agent:dev@sha256:abc123')).toBe('dev');
  });

  test('returns null for a digest-only reference', () => {
    expect(parseImageTag('ghcr.io/x/agent@sha256:abc123')).toBeNull();
  });

  test('reads the tag past a registry port', () => {
    expect(parseImageTag('localhost:5000/agent:dev')).toBe('dev');
  });

  test.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['agent:', 'an empty tag'],
    ['agent:-bad', 'a leading dash'],
    ['agent:bad tag', 'whitespace'],
  ])('returns null for %s (%s)', (reference) => {
    expect(parseImageTag(reference)).toBeNull();
  });
});

describe('resolveAgentImage', () => {
  function dockerWithImage(image: string | undefined) {
    return {
      getContainer: mock(() => ({
        inspect: mock(() => Promise.resolve({ Config: { Image: image } })),
      })),
    };
  }

  test('prefers AGENT_IMAGE over inspecting the container', async () => {
    const docker = dockerWithImage('ghcr.io/x/agent:fromdocker');
    const result = await resolveAgentImage(docker as never, 'hlm-agent', 'ghcr.io/x/agent:fromenv');
    expect(result).toEqual({ image: 'ghcr.io/x/agent:fromenv', tag: 'fromenv' });
    expect(docker.getContainer).not.toHaveBeenCalled();
  });

  test('trims a padded AGENT_IMAGE', async () => {
    const result = await resolveAgentImage(null, 'hlm-agent', '  ghcr.io/x/agent:dev  ');
    expect(result).toEqual({ image: 'ghcr.io/x/agent:dev', tag: 'dev' });
  });

  test('inspects its own container when AGENT_IMAGE is unset', async () => {
    const docker = dockerWithImage('ghcr.io/x/agent:dev');
    const result = await resolveAgentImage(docker as never, 'hlm-agent', undefined);
    expect(result).toEqual({ image: 'ghcr.io/x/agent:dev', tag: 'dev' });
    expect(docker.getContainer).toHaveBeenCalledWith('hlm-agent');
  });

  test('falls back to an empty AGENT_IMAGE by inspecting', async () => {
    const docker = dockerWithImage('ghcr.io/x/agent:dev');
    const result = await resolveAgentImage(docker as never, 'hlm-agent', '   ');
    expect(result.tag).toBe('dev');
  });

  test('reports nothing on a ZFS-only host with no Docker and no AGENT_IMAGE', async () => {
    expect(await resolveAgentImage(null, 'hlm-agent', undefined)).toEqual({ image: null, tag: null });
  });

  test('reports nothing when the container inspect fails', async () => {
    const docker = {
      getContainer: mock(() => ({
        inspect: mock(() => Promise.reject(new Error('no such container'))),
      })),
    };
    expect(await resolveAgentImage(docker as never, 'hlm-agent', undefined)).toEqual({
      image: null,
      tag: null,
    });
  });

  test('reports nothing when inspect returns no image', async () => {
    const docker = dockerWithImage(undefined);
    expect(await resolveAgentImage(docker as never, 'hlm-agent', undefined)).toEqual({
      image: null,
      tag: null,
    });
  });

  test('reports the image with a null tag when only a digest pins it', async () => {
    const docker = dockerWithImage('ghcr.io/x/agent@sha256:abc123');
    expect(await resolveAgentImage(docker as never, 'hlm-agent', undefined)).toEqual({
      image: 'ghcr.io/x/agent@sha256:abc123',
      tag: null,
    });
  });
});

describe('createAgentImageResolver', () => {
  function dockerFailingTimes(failures: number, image = 'ghcr.io/x/agent:dev') {
    let calls = 0;
    return {
      calls: () => calls,
      docker: {
        getContainer: () => ({
          inspect: () => {
            calls += 1;
            return calls <= failures
              ? Promise.reject(new Error('connect ECONNREFUSED'))
              : Promise.resolve({ Config: { Image: image } });
          },
        }),
      },
    };
  }

  test('retries after a failed resolution instead of freezing the null', async () => {
    const { docker, calls } = dockerFailingTimes(1);
    const resolve = createAgentImageResolver(docker as never, 'hlm-agent', undefined);

    expect(await resolve()).toEqual({ image: null, tag: null });
    expect(await resolve()).toEqual({ image: 'ghcr.io/x/agent:dev', tag: 'dev' });
    expect(calls()).toBe(2);
  });

  test('caches a success so later calls do not touch Docker again', async () => {
    const { docker, calls } = dockerFailingTimes(0);
    const resolve = createAgentImageResolver(docker as never, 'hlm-agent', undefined);

    await resolve();
    await resolve();
    await resolve();
    expect(calls()).toBe(1);
  });

  test('shares one in-flight resolution across concurrent callers', async () => {
    const { docker, calls } = dockerFailingTimes(0);
    const resolve = createAgentImageResolver(docker as never, 'hlm-agent', undefined);

    const [a, b] = await Promise.all([resolve(), resolve()]);
    expect(a).toEqual({ image: 'ghcr.io/x/agent:dev', tag: 'dev' });
    expect(b).toEqual(a);
    expect(calls()).toBe(1);
  });

  test('never touches Docker when AGENT_IMAGE is set', async () => {
    const { docker, calls } = dockerFailingTimes(0);
    const resolve = createAgentImageResolver(docker as never, 'hlm-agent', 'ghcr.io/x/agent:pinned');

    expect(await resolve()).toEqual({ image: 'ghcr.io/x/agent:pinned', tag: 'pinned' });
    expect(calls()).toBe(0);
  });

  test('gives up on a hung inspect instead of leaving /info awaiting it forever', async () => {
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as typeof globalThis.setTimeout;

    try {
      let inspectCalls = 0;
      const docker = {
        getContainer: () => ({
          inspect: () => {
            inspectCalls += 1;
            return new Promise(() => {});
          },
        }),
      };
      const resolve = createAgentImageResolver(docker as never, 'hlm-agent', undefined);

      expect(await resolve()).toEqual({ image: null, tag: null });
      expect(await resolve()).toEqual({ image: null, tag: null });
      expect(inspectCalls).toBe(2);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test('keeps retrying on a host that can never resolve', async () => {
    const { docker, calls } = dockerFailingTimes(Number.MAX_SAFE_INTEGER);
    const resolve = createAgentImageResolver(docker as never, 'hlm-agent', undefined);

    await resolve();
    await resolve();
    expect(calls()).toBe(2);
  });
});

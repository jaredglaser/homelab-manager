import { describe, expect, test, mock, beforeAll } from 'bun:test';
import { parseImageTag, resolveAgentImage } from '../lib/agent-image';

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

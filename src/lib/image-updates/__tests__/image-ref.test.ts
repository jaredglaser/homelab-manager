import { describe, expect, test } from 'bun:test';
import { InvalidImageRefError, parseImageRef } from '../image-ref';

describe('parseImageRef', () => {
  test('bare official image gets docker.io and library namespace', () => {
    expect(parseImageRef('redis:7')).toEqual({
      registry: 'docker.io',
      repo: 'library/redis',
      tag: '7',
      digest: null,
    });
  });

  test('bare namespaced image gets docker.io without library prefix', () => {
    expect(parseImageRef('linuxserver/nginx')).toEqual({
      registry: 'docker.io',
      repo: 'linuxserver/nginx',
      tag: null,
      digest: null,
    });
  });

  test('registry host with a dot is split off', () => {
    expect(parseImageRef('ghcr.io/owner/app:v1.2.3')).toEqual({
      registry: 'ghcr.io',
      repo: 'owner/app',
      tag: 'v1.2.3',
      digest: null,
    });
  });

  test('registry port is split off and does not swallow the tag', () => {
    expect(parseImageRef('localhost:5000/my/app:2.1')).toEqual({
      registry: 'localhost:5000',
      repo: 'my/app',
      tag: '2.1',
      digest: null,
    });
  });

  test('docker.io alias hosts normalize to the implicit registry', () => {
    expect(parseImageRef('index.docker.io/redis:7')).toEqual({
      registry: 'docker.io',
      repo: 'library/redis',
      tag: '7',
      digest: null,
    });
    expect(parseImageRef('registry-1.docker.io/library/redis:7')).toEqual({
      registry: 'docker.io',
      repo: 'library/redis',
      tag: '7',
      digest: null,
    });
  });

  test('a mixed-case Hub host resolves to the docker.io hub path', () => {
    expect(parseImageRef('Docker.io/redis:7')).toEqual({
      registry: 'docker.io',
      repo: 'library/redis',
      tag: '7',
      digest: null,
    });
  });

  test('digest ref keeps the digest and drops the tag', () => {
    const digest = 'sha256:' + 'a'.repeat(64);
    expect(parseImageRef(`ghcr.io/owner/app:1.0@${digest}`)).toEqual({
      registry: 'ghcr.io',
      repo: 'owner/app',
      tag: '1.0',
      digest,
    });
  });

  test('digest-only ref has a null tag', () => {
    const digest = 'sha256:' + 'b'.repeat(64);
    expect(parseImageRef(`nginx@${digest}`)).toEqual({
      registry: 'docker.io',
      repo: 'library/nginx',
      tag: null,
      digest,
    });
  });

  test('a colon in a middle path segment is not a tag separator', () => {
    expect(parseImageRef('ghcr.io/owner/app:feature/some-branch')).toEqual({
      registry: 'ghcr.io',
      repo: 'owner/app:feature/some-branch',
      tag: null,
      digest: null,
    });
  });

  test('empty ref throws its exact message', () => {
    expect(() => parseImageRef('  ')).toThrow(new InvalidImageRefError('Image reference is empty'));
  });

  test('empty tag throws its exact message', () => {
    expect(() => parseImageRef('redis:')).toThrow(
      new InvalidImageRefError('Image reference "redis:" has an empty tag'),
    );
  });

  test('empty digest throws its exact message', () => {
    expect(() => parseImageRef('redis@')).toThrow(
      new InvalidImageRefError('Image reference "redis@" has an empty digest'),
    );
  });

  test('bare digest with no repo throws its exact message', () => {
    expect(() => parseImageRef('@sha256:' + 'a'.repeat(64))).toThrow(
      new InvalidImageRefError('Image reference "@sha256:' + 'a'.repeat(64) + '" has no repository part'),
    );
  });
});

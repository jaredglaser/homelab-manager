import { describe, it, expect } from 'bun:test';
import { parseDockerImage } from '../docker-image';

describe('parseDockerImage', () => {
  it('parses image:tag', () => {
    expect(parseDockerImage('nginx:1.25')).toEqual({
      registry: null,
      repository: 'nginx',
      tag: '1.25',
    });
  });

  it('parses org/image:tag', () => {
    expect(parseDockerImage('jaredglaser/homelab-manager:latest')).toEqual({
      registry: null,
      repository: 'jaredglaser/homelab-manager',
      tag: 'latest',
    });
  });

  it('parses registry/org/image:tag', () => {
    expect(parseDockerImage('ghcr.io/jaredglaser/homelab-manager:v4.0.0')).toEqual({
      registry: 'ghcr.io',
      repository: 'jaredglaser/homelab-manager',
      tag: 'v4.0.0',
    });
  });

  it('defaults tag to latest when missing', () => {
    expect(parseDockerImage('nginx')).toEqual({
      registry: null,
      repository: 'nginx',
      tag: 'latest',
    });
  });

  it('handles sha256 digest', () => {
    expect(parseDockerImage('nginx@sha256:abc123')).toEqual({
      registry: null,
      repository: 'nginx',
      tag: 'sha256:abc123',
    });
  });

  it('handles docker.io/library prefix', () => {
    expect(parseDockerImage('docker.io/library/nginx:alpine')).toEqual({
      registry: 'docker.io',
      repository: 'library/nginx',
      tag: 'alpine',
    });
  });

  it('handles localhost registry', () => {
    expect(parseDockerImage('localhost/myapp:dev')).toEqual({
      registry: 'localhost',
      repository: 'myapp',
      tag: 'dev',
    });
  });

  it('handles registry with port', () => {
    expect(parseDockerImage('registry.local:5000/myapp:1.0')).toEqual({
      registry: 'registry.local:5000',
      repository: 'myapp',
      tag: '1.0',
    });
  });
});

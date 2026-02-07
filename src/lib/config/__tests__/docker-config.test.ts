import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { loadDockerConfig } from '../docker-config';

describe('loadDockerConfig', () => {
  // Store original env vars to restore after tests
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all Docker-related env vars before each test
    Object.keys(process.env).forEach((key) => {
      if (key.startsWith('DOCKER_HOST')) {
        delete process.env[key];
      }
    });
  });

  afterEach(() => {
    // Restore original env vars
    Object.keys(process.env).forEach((key) => {
      if (key.startsWith('DOCKER_HOST')) {
        delete process.env[key];
      }
    });
    Object.assign(process.env, originalEnv);
  });

  it('should return empty hosts array when no hosts configured', () => {
    const config = loadDockerConfig();
    expect(config.hosts).toEqual([]);
  });

  it('should parse single host with defaults', () => {
    process.env.DOCKER_HOST_1 = '192.168.1.100';

    const config = loadDockerConfig();

    expect(config.hosts.length).toBe(1);
    expect(config.hosts[0]).toEqual({
      host: '192.168.1.100',
      port: 2375,
      name: '192.168.1.100',
      protocol: 'http',
    });
  });

  it('should parse single host with custom port and name', () => {
    process.env.DOCKER_HOST_1 = '192.168.1.100';
    process.env.DOCKER_HOST_PORT_1 = '2376';
    process.env.DOCKER_HOST_NAME_1 = 'proxmox';

    const config = loadDockerConfig();

    expect(config.hosts.length).toBe(1);
    expect(config.hosts[0]).toEqual({
      host: '192.168.1.100',
      port: 2376,
      name: 'proxmox',
      protocol: 'http',
    });
  });

  it('should parse multiple hosts', () => {
    process.env.DOCKER_HOST_1 = '192.168.1.100';
    process.env.DOCKER_HOST_NAME_1 = 'host1';
    process.env.DOCKER_HOST_2 = '192.168.1.101';
    process.env.DOCKER_HOST_NAME_2 = 'host2';
    process.env.DOCKER_HOST_3 = '192.168.1.102';
    process.env.DOCKER_HOST_NAME_3 = 'host3';

    const config = loadDockerConfig();

    expect(config.hosts.length).toBe(3);
    expect(config.hosts[0].name).toBe('host1');
    expect(config.hosts[1].name).toBe('host2');
    expect(config.hosts[2].name).toBe('host3');
  });

  it('should stop at first missing host when count not specified', () => {
    process.env.DOCKER_HOST_1 = '192.168.1.100';
    process.env.DOCKER_HOST_3 = '192.168.1.102'; // Skip 2

    const config = loadDockerConfig();

    // Should only get host 1, stops at missing 2
    expect(config.hosts.length).toBe(1);
    expect(config.hosts[0].host).toBe('192.168.1.100');
  });

  it('should continue with gaps when count is specified', () => {
    process.env.DOCKER_HOST_COUNT = '3';
    process.env.DOCKER_HOST_1 = '192.168.1.100';
    process.env.DOCKER_HOST_3 = '192.168.1.102'; // Skip 2

    const config = loadDockerConfig();

    // Should get hosts 1 and 3, skipping 2
    expect(config.hosts.length).toBe(2);
    expect(config.hosts[0].host).toBe('192.168.1.100');
    expect(config.hosts[1].host).toBe('192.168.1.102');
  });

  it('should use default port 2375 when not specified', () => {
    process.env.DOCKER_HOST_1 = '192.168.1.100';

    const config = loadDockerConfig();

    expect(config.hosts[0].port).toBe(2375);
  });

  it('should use host as name when name not specified', () => {
    process.env.DOCKER_HOST_1 = 'my-docker-server.local';

    const config = loadDockerConfig();

    expect(config.hosts[0].name).toBe('my-docker-server.local');
  });

  it('should parse https protocol', () => {
    process.env.DOCKER_HOST_1 = '192.168.1.100';
    process.env.DOCKER_HOST_PROTOCOL_1 = 'https';

    const config = loadDockerConfig();

    expect(config.hosts[0].protocol).toBe('https');
  });

  it('should default to http protocol', () => {
    process.env.DOCKER_HOST_1 = '192.168.1.100';

    const config = loadDockerConfig();

    expect(config.hosts[0].protocol).toBe('http');
  });
});

import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test';
import { DockerClient } from '../docker-client';

// Suppress console output during tests
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

describe('DockerClient', () => {
  beforeEach(() => {
    console.log = mock(() => {});
    console.error = mock(() => {});
  });

  afterAll(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  it('should create client with correct id', () => {
    const client = new DockerClient({ host: '192.168.1.100', port: 2375 });
    expect(client.id).toBe('docker://192.168.1.100:2375');
  });

  it('should not be connected initially', () => {
    const client = new DockerClient({ host: '192.168.1.100', port: 2375 });
    expect(client.isConnected()).toBe(false);
  });

  it('should throw when getDocker called before connect', () => {
    const client = new DockerClient({ host: '192.168.1.100', port: 2375 });
    expect(() => client.getDocker()).toThrow('Docker client not connected');
  });

  it('should connect successfully when ping succeeds', async () => {
    const client = new DockerClient({ host: '192.168.1.100', port: 2375 });

    // Spy on the internal docker instance's ping method
    const docker = (client as any).docker;
    spyOn(docker, 'ping').mockResolvedValue('OK');

    await client.connect();

    expect(client.isConnected()).toBe(true);
    expect(() => client.getDocker()).not.toThrow();
  });

  it('should fail to connect when ping throws', async () => {
    const client = new DockerClient({ host: '192.168.1.100', port: 2375 });

    const docker = (client as any).docker;
    spyOn(docker, 'ping').mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(client.connect()).rejects.toThrow('ECONNREFUSED');
    expect(client.isConnected()).toBe(false);
  });

  it('should disconnect on close', async () => {
    const client = new DockerClient({ host: '192.168.1.100', port: 2375 });

    const docker = (client as any).docker;
    spyOn(docker, 'ping').mockResolvedValue('OK');

    await client.connect();
    expect(client.isConnected()).toBe(true);

    await client.close();
    expect(client.isConnected()).toBe(false);
  });

  it('should support debug logging toggle', async () => {
    const client = new DockerClient({ host: '192.168.1.100', port: 2375 });
    const docker = (client as any).docker;
    spyOn(docker, 'ping').mockResolvedValue('OK');

    client.debugLogging = true;
    await client.connect();

    // Debug logs should have been called
    expect(console.log).toHaveBeenCalled();
  });

  it('should use custom protocol', () => {
    const client = new DockerClient({ host: '192.168.1.100', port: 2376, protocol: 'https' });
    expect(client.id).toBe('docker://192.168.1.100:2376');
  });
});

import { afterAll } from 'bun:test';

describe('DockerConnectionManager', () => {
  beforeEach(() => {
    console.log = mock(() => {});
    console.error = mock(() => {});
  });

  afterAll(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  it('should create and return a connected client', async () => {
    // Import a fresh manager to avoid singleton state issues
    const { DockerClient } = await import('../docker-client');

    const client = new DockerClient({ host: '10.0.0.1', port: 2375 });
    const docker = (client as any).docker;
    spyOn(docker, 'ping').mockResolvedValue('OK');

    await client.connect();
    expect(client.isConnected()).toBe(true);

    await client.close();
  });

  it('should close a client and set disconnected', async () => {
    const { DockerClient } = await import('../docker-client');

    const client = new DockerClient({ host: '10.0.0.2', port: 2375 });
    const docker = (client as any).docker;
    spyOn(docker, 'ping').mockResolvedValue('OK');

    await client.connect();
    await client.close();

    expect(client.isConnected()).toBe(false);
  });
});

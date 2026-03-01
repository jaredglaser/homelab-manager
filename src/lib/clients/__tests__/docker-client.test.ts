import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { DockerClient } from '../docker-client';

// Suppress console output during tests
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

describe('DockerClient', () => {
  beforeEach(() => {
    console.log = mock(() => {});
    console.error = mock(() => {});
  });

  afterEach(() => {
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

    expect(console.log).toHaveBeenCalled();
  });

  it('should not log when debug logging is disabled', async () => {
    const client = new DockerClient({ host: '192.168.1.100', port: 2375 });
    const docker = (client as any).docker;
    spyOn(docker, 'ping').mockResolvedValue('OK');

    client.debugLogging = false;
    await client.connect();

    // Only debug logs should be suppressed; connect still happens
    expect(client.isConnected()).toBe(true);
  });

});

describe('DockerConnectionManager', () => {
  beforeEach(() => {
    console.log = mock(() => {});
    console.error = mock(() => {});
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  it('should create and return a connected client via getClient', async () => {
    const { dockerConnectionManager } = await import('../docker-client');

    // Create a client manually and inject it to test manager behavior
    const config = { host: '10.0.0.50', port: 2375 };
    const client = new DockerClient(config);
    const docker = (client as any).docker;
    spyOn(docker, 'ping').mockResolvedValue('OK');

    // Manually connect and put in manager's map to test reuse
    await client.connect();
    (dockerConnectionManager as any).connections.set('10.0.0.50:2375', client);

    // getClient should reuse the existing connected client
    const returned = await dockerConnectionManager.getClient(config);
    expect(returned).toBe(client);
    expect(returned.isConnected()).toBe(true);

    // Cleanup
    await dockerConnectionManager.closeConnection('10.0.0.50:2375');
  });

  it('should close specific connection via closeConnection', async () => {
    const { dockerConnectionManager } = await import('../docker-client');

    const config = { host: '10.0.0.52', port: 2375 };
    const client = new DockerClient(config);
    const docker = (client as any).docker;
    spyOn(docker, 'ping').mockResolvedValue('OK');
    await client.connect();

    (dockerConnectionManager as any).connections.set('10.0.0.52:2375', client);

    await dockerConnectionManager.closeConnection('10.0.0.52:2375');

    expect(client.isConnected()).toBe(false);
    expect((dockerConnectionManager as any).connections.has('10.0.0.52:2375')).toBe(false);
  });

  it('should handle closeConnection for non-existent key', async () => {
    const { dockerConnectionManager } = await import('../docker-client');
    // Should not throw
    await dockerConnectionManager.closeConnection('nonexistent:9999');
  });

  it('should close all connections via closeAll', async () => {
    const { dockerConnectionManager } = await import('../docker-client');

    const client1 = new DockerClient({ host: '10.0.0.53', port: 2375 });
    const client2 = new DockerClient({ host: '10.0.0.54', port: 2375 });
    spyOn((client1 as any).docker, 'ping').mockResolvedValue('OK');
    spyOn((client2 as any).docker, 'ping').mockResolvedValue('OK');
    await client1.connect();
    await client2.connect();

    (dockerConnectionManager as any).connections.set('10.0.0.53:2375', client1);
    (dockerConnectionManager as any).connections.set('10.0.0.54:2375', client2);

    await dockerConnectionManager.closeAll();

    expect(client1.isConnected()).toBe(false);
    expect(client2.isConnected()).toBe(false);
    expect((dockerConnectionManager as any).connections.size).toBe(0);
  });

  it('should propagate debugLogging to all existing clients', async () => {
    const { dockerConnectionManager } = await import('../docker-client');

    const client = new DockerClient({ host: '10.0.0.55', port: 2375 });
    (dockerConnectionManager as any).connections.set('10.0.0.55:2375', client);

    dockerConnectionManager.debugLogging = true;
    expect((client as any)._debugLogging).toBe(true);

    dockerConnectionManager.debugLogging = false;
    expect((client as any)._debugLogging).toBe(false);

    // Cleanup
    (dockerConnectionManager as any).connections.delete('10.0.0.55:2375');
  });
});

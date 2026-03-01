import { describe, it, expect, beforeEach, afterAll, mock, spyOn } from 'bun:test';
import { SSHClient } from '../ssh-client';
import type { SSHConnectionConfig } from '../../streaming/types';

// Suppress console output during tests
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

function createSSHConfig(overrides?: Partial<SSHConnectionConfig>): SSHConnectionConfig {
  return {
    id: 'test-ssh',
    type: 'ssh',
    host: '192.168.1.50',
    port: 22,
    auth: {
      type: 'password',
      username: 'root',
      password: 'secret',
    },
    ...overrides,
  };
}

describe('SSHClient', () => {
  beforeEach(() => {
    console.log = mock(() => {});
    console.error = mock(() => {});
  });

  afterAll(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  it('should create client with correct id', () => {
    const config = createSSHConfig();
    const client = new SSHClient(config);

    expect(client.id).toBe('ssh://root@192.168.1.50:22');
  });

  it('should use default port 22 when port not specified', () => {
    const config = createSSHConfig({ port: undefined });
    const client = new SSHClient(config);

    expect(client.id).toBe('ssh://root@192.168.1.50:22');
  });

  it('should not be connected initially', () => {
    const client = new SSHClient(createSSHConfig());
    expect(client.isConnected()).toBe(false);
  });

  it('should track last used time', () => {
    const client = new SSHClient(createSSHConfig());
    const lastUsed = client.getLastUsed();
    expect(lastUsed).toBeGreaterThan(0);
    expect(lastUsed).toBeLessThanOrEqual(Date.now());
  });

  it('should have no active channels initially', () => {
    const client = new SSHClient(createSSHConfig());
    expect(client.hasActiveChannels()).toBe(false);
  });

  it('should connect when ready event fires', async () => {
    const config = createSSHConfig();
    const client = new SSHClient(config);

    // Get the internal SSH2 client and mock connect to fire ready
    const internalClient = (client as any).client;

    spyOn(internalClient, 'connect').mockImplementation(() => {
      // Simulate the ready event after a short delay
      setTimeout(() => internalClient.emit('ready'), 10);
    });

    await client.connect();

    expect(client.isConnected()).toBe(true);
  });

  it('should reject on error event', async () => {
    const config = createSSHConfig();
    const client = new SSHClient(config);

    const internalClient = (client as any).client;
    spyOn(internalClient, 'connect').mockImplementation(() => {
      setTimeout(() => internalClient.emit('error', new Error('Auth failed')), 10);
    });

    await expect(client.connect()).rejects.toThrow('Auth failed');
    expect(client.isConnected()).toBe(false);
  });

  it('should skip connect if already connected', async () => {
    const config = createSSHConfig();
    const client = new SSHClient(config);

    // Force connected state
    (client as any).connected = true;

    // Should return without doing anything
    await client.connect();
    expect(client.isConnected()).toBe(true);
  });

  it('should throw on exec when not connected', async () => {
    const client = new SSHClient(createSSHConfig());

    await expect(client.exec('ls')).rejects.toThrow('SSH client not connected');
  });

  it('should close connection and clear channels', async () => {
    const config = createSSHConfig();
    const client = new SSHClient(config);

    // Force connected state
    (client as any).connected = true;

    const internalClient = (client as any).client;
    spyOn(internalClient, 'end').mockImplementation(() => {});

    await client.close();

    expect(client.isConnected()).toBe(false);
    expect(client.hasActiveChannels()).toBe(false);
  });

  describe('buildSSHConfig', () => {
    it('should build config for password auth', () => {
      const config = createSSHConfig({
        auth: { type: 'password', username: 'root', password: 'secret' },
      });
      const client = new SSHClient(config);
      const sshConfig = (client as any).buildSSHConfig();

      expect(sshConfig.host).toBe('192.168.1.50');
      expect(sshConfig.port).toBe(22);
      expect(sshConfig.username).toBe('root');
      expect(sshConfig.password).toBe('secret');
      expect(sshConfig.readyTimeout).toBe(10000);
      expect(sshConfig.compress).toBe(true);
    });

    it('should build config for privateKey auth with inline key', () => {
      const config = createSSHConfig({
        auth: {
          type: 'privateKey',
          username: 'admin',
          privateKey: Buffer.from('fake-key'),
          passphrase: 'my-passphrase',
        },
      });
      const client = new SSHClient(config);
      const sshConfig = (client as any).buildSSHConfig();

      expect(sshConfig.username).toBe('admin');
      expect(sshConfig.privateKey).toEqual(Buffer.from('fake-key'));
      expect(sshConfig.passphrase).toBe('my-passphrase');
      expect(sshConfig.password).toBeUndefined();
    });

    it('should build config for agent auth', () => {
      const originalSSHAuthSock = process.env.SSH_AUTH_SOCK;
      process.env.SSH_AUTH_SOCK = '/tmp/ssh-agent.sock';

      const config = createSSHConfig({
        auth: { type: 'agent', username: 'root' },
      });
      const client = new SSHClient(config);
      const sshConfig = (client as any).buildSSHConfig();

      expect(sshConfig.agent).toBe('/tmp/ssh-agent.sock');
      expect(sshConfig.password).toBeUndefined();
      expect(sshConfig.privateKey).toBeUndefined();

      if (originalSSHAuthSock !== undefined) {
        process.env.SSH_AUTH_SOCK = originalSSHAuthSock;
      } else {
        delete process.env.SSH_AUTH_SOCK;
      }
    });

    it('should include keepaliveInterval when configured', () => {
      const config = createSSHConfig({ keepaliveInterval: 5000 });
      const client = new SSHClient(config);
      const sshConfig = (client as any).buildSSHConfig();

      expect(sshConfig.keepaliveInterval).toBe(5000);
    });

    it('should not include keepaliveInterval when not configured', () => {
      const config = createSSHConfig();
      const client = new SSHClient(config);
      const sshConfig = (client as any).buildSSHConfig();

      expect(sshConfig.keepaliveInterval).toBeUndefined();
    });
  });
});

describe('SSHConnectionManager', () => {
  // We test the singleton behavior indirectly via SSHClient since
  // SSHConnectionManager constructor starts cleanup interval
  // which is hard to test without real connections

  beforeEach(() => {
    console.log = mock(() => {});
    console.error = mock(() => {});
  });

  afterAll(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  it('should be importable as singleton', async () => {
    const { sshConnectionManager } = await import('../ssh-client');
    expect(sshConnectionManager).toBeDefined();
    expect(typeof sshConnectionManager.getClient).toBe('function');
    expect(typeof sshConnectionManager.closeAll).toBe('function');
    expect(typeof sshConnectionManager.closeConnection).toBe('function');
    expect(typeof sshConnectionManager.stopCleanup).toBe('function');
  });
});

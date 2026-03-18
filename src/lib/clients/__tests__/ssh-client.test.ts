import { describe, it, expect, beforeEach, afterEach, mock, spyOn, jest } from 'bun:test';
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

  afterEach(() => {
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

    const internalClient = (client as any).client;

    spyOn(internalClient, 'connect').mockImplementation(() => {
      process.nextTick(() => internalClient.emit('ready'));
    });

    await client.connect();

    expect(client.isConnected()).toBe(true);
  });

  it('should reject on error event', async () => {
    const config = createSSHConfig();
    const client = new SSHClient(config);

    const internalClient = (client as any).client;
    spyOn(internalClient, 'connect').mockImplementation(() => {
      process.nextTick(() => internalClient.emit('error', new Error('Auth failed')));
    });

    await expect(client.connect()).rejects.toThrow('Auth failed');
    expect(client.isConnected()).toBe(false);
  });

  it('should handle banner event during connect', async () => {
    const config = createSSHConfig();
    const client = new SSHClient(config);

    const internalClient = (client as any).client;

    spyOn(internalClient, 'connect').mockImplementation(() => {
      process.nextTick(() => {
        internalClient.emit('banner', 'Welcome to SSH server');
        internalClient.emit('ready');
      });
    });

    await client.connect();
    expect(client.isConnected()).toBe(true);
    expect(console.log).toHaveBeenCalled();
  });

  it('should handle close event after connect', async () => {
    const config = createSSHConfig();
    const client = new SSHClient(config);

    const internalClient = (client as any).client;

    spyOn(internalClient, 'connect').mockImplementation(() => {
      process.nextTick(() => internalClient.emit('ready'));
    });

    await client.connect();
    expect(client.isConnected()).toBe(true);

    // Simulate remote close
    internalClient.emit('close');
    expect(client.isConnected()).toBe(false);
  });

  it('should reject on connection timeout after 10 seconds', async () => {
    jest.useFakeTimers();
    try {
      const config = createSSHConfig();
      const client = new SSHClient(config);

      const internalClient = (client as any).client;

      // Mock connect but never emit 'ready' or 'error' — let the timeout fire
      spyOn(internalClient, 'connect').mockImplementation(() => {});
      spyOn(internalClient, 'end').mockImplementation(() => {});

      const connectPromise = client.connect();

      // Advance past the 10s timeout
      jest.advanceTimersByTime(11_000);

      await expect(connectPromise).rejects.toThrow('SSH connection timeout');
    } finally {
      jest.useRealTimers();
    }
  });

  it('should handle channel close and stderr events during exec', async () => {
    const config = createSSHConfig();
    const client = new SSHClient(config);
    (client as any).connected = true;

    let channelCloseCallback: (() => void) | undefined;
    let stderrCallback: ((data: Buffer) => void) | undefined;

    const mockChannel = {
      on: mock(function(this: any, event: string, cb: any) {
        if (event === 'close') channelCloseCallback = cb;
        return this;
      }),
      stderr: {
        on: mock(function(this: any, event: string, cb: any) {
          if (event === 'data') stderrCallback = cb;
          return this;
        }),
      },
      close: mock(() => {}),
    };

    const internalClient = (client as any).client;
    spyOn(internalClient, 'exec').mockImplementation((_cmd: string, cb: any) => {
      cb(null, mockChannel);
    });

    await client.exec('ls -la');
    expect(client.hasActiveChannels()).toBe(true);

    // Trigger stderr
    stderrCallback!(Buffer.from('warning: something'));
    expect(console.error).toHaveBeenCalled();

    // Trigger channel close
    channelCloseCallback!();
    expect(client.hasActiveChannels()).toBe(false);

    spyOn(internalClient, 'end').mockImplementation(() => {});
    await client.close();
  });

  it('should handle close with channel that throws on close', async () => {
    const config = createSSHConfig();
    const client = new SSHClient(config);
    (client as any).connected = true;

    const throwingChannel = {
      close: mock(() => { throw new Error('already closed'); }),
    };
    (client as any).channels.add(throwingChannel);

    const internalClient = (client as any).client;
    spyOn(internalClient, 'end').mockImplementation(() => {});

    // Should not throw despite channel.close() throwing
    await client.close();
    expect(client.isConnected()).toBe(false);
  });

  it('should skip connect if already connected', async () => {
    const config = createSSHConfig();
    const client = new SSHClient(config);

    (client as any).connected = true;

    await client.connect();
    expect(client.isConnected()).toBe(true);
  });

  it('should throw on exec when not connected', async () => {
    const client = new SSHClient(createSSHConfig());

    await expect(client.exec('ls')).rejects.toThrow('SSH client not connected');
  });

  it('should execute command and return channel when connected', async () => {
    const config = createSSHConfig();
    const client = new SSHClient(config);
    (client as any).connected = true;

    const mockChannel = {
      on: mock(function(this: any) { return this; }),
      stderr: { on: mock(function(this: any) { return this; }) },
      close: mock(() => {}),
    };

    const internalClient = (client as any).client;
    spyOn(internalClient, 'exec').mockImplementation((_cmd: string, cb: any) => {
      cb(null, mockChannel);
    });

    const stream = await client.exec('ls -la');
    expect(stream).toBe(mockChannel as any);
    expect(client.hasActiveChannels()).toBe(true);

    spyOn(internalClient, 'end').mockImplementation(() => {});
    await client.close();
  });

  it('should reject exec when internal exec errors', async () => {
    const config = createSSHConfig();
    const client = new SSHClient(config);
    (client as any).connected = true;

    const internalClient = (client as any).client;
    spyOn(internalClient, 'exec').mockImplementation((_cmd: string, cb: any) => {
      cb(new Error('exec failed'));
    });

    await expect(client.exec('ls')).rejects.toThrow('exec failed');

    spyOn(internalClient, 'end').mockImplementation(() => {});
    await client.close();
  });

  it('should close connection and clear channels', async () => {
    const config = createSSHConfig();
    const client = new SSHClient(config);

    (client as any).connected = true;

    const internalClient = (client as any).client;
    spyOn(internalClient, 'end').mockImplementation(() => {});

    await client.close();

    expect(client.isConnected()).toBe(false);
    expect(client.hasActiveChannels()).toBe(false);
  });

  it('should close active channels on close', async () => {
    const config = createSSHConfig();
    const client = new SSHClient(config);
    (client as any).connected = true;

    const mockChannel = {
      on: mock(function(this: any) { return this; }),
      stderr: { on: mock(function(this: any) { return this; }) },
      close: mock(() => {}),
    };

    const internalClient = (client as any).client;
    spyOn(internalClient, 'exec').mockImplementation((_cmd: string, cb: any) => {
      cb(null, mockChannel);
    });

    await client.exec('long-running-command');
    expect(client.hasActiveChannels()).toBe(true);

    spyOn(internalClient, 'end').mockImplementation(() => {});
    await client.close();

    expect(mockChannel.close).toHaveBeenCalled();
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

      try {
        const config = createSSHConfig({
          auth: { type: 'agent', username: 'root' },
        });
        const client = new SSHClient(config);
        const sshConfig = (client as any).buildSSHConfig();

        expect(sshConfig.agent).toBe('/tmp/ssh-agent.sock');
        expect(sshConfig.password).toBeUndefined();
        expect(sshConfig.privateKey).toBeUndefined();
      } finally {
        if (originalSSHAuthSock !== undefined) {
          process.env.SSH_AUTH_SOCK = originalSSHAuthSock;
        } else {
          delete process.env.SSH_AUTH_SOCK;
        }
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
  beforeEach(() => {
    console.log = mock(() => {});
    console.error = mock(() => {});
  });

  afterEach(async () => {
    // Clear any injected connections to prevent singleton state leaking between tests
    const { sshConnectionManager } = await import('../ssh-client');
    (sshConnectionManager as any).connections.clear();
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

  it('should reuse existing connected client', async () => {
    const { sshConnectionManager } = await import('../ssh-client');

    const config = createSSHConfig({ host: '10.0.0.80' });
    const client = new SSHClient(config);
    (client as any).connected = true;

    // Inject client into manager's connection map
    (sshConnectionManager as any).connections.set('root@10.0.0.80:22', client);

    const returned = await sshConnectionManager.getClient(config);
    expect(returned).toBe(client);

    // Cleanup
    (sshConnectionManager as any).connections.delete('root@10.0.0.80:22');
  });

  it('should close specific connection via closeConnection', async () => {
    const { sshConnectionManager } = await import('../ssh-client');

    const config = createSSHConfig({ host: '10.0.0.81' });
    const client = new SSHClient(config);
    (client as any).connected = true;

    const internalClient = (client as any).client;
    spyOn(internalClient, 'end').mockImplementation(() => {});

    (sshConnectionManager as any).connections.set('root@10.0.0.81:22', client);

    await sshConnectionManager.closeConnection('root@10.0.0.81:22');

    expect(client.isConnected()).toBe(false);
    expect((sshConnectionManager as any).connections.has('root@10.0.0.81:22')).toBe(false);
  });

  it('should handle closeConnection for non-existent key', async () => {
    const { sshConnectionManager } = await import('../ssh-client');
    await sshConnectionManager.closeConnection('nonexistent');
  });

  it('should close all connections', async () => {
    const { sshConnectionManager } = await import('../ssh-client');

    const client1 = new SSHClient(createSSHConfig({ host: '10.0.0.82' }));
    const client2 = new SSHClient(createSSHConfig({ host: '10.0.0.83' }));
    (client1 as any).connected = true;
    (client2 as any).connected = true;
    spyOn((client1 as any).client, 'end').mockImplementation(() => {});
    spyOn((client2 as any).client, 'end').mockImplementation(() => {});

    (sshConnectionManager as any).connections.set('root@10.0.0.82:22', client1);
    (sshConnectionManager as any).connections.set('root@10.0.0.83:22', client2);

    await sshConnectionManager.closeAll();

    expect(client1.isConnected()).toBe(false);
    expect(client2.isConnected()).toBe(false);
    expect((sshConnectionManager as any).connections.size).toBe(0);
  });

  it('should stopCleanup without error', async () => {
    const { sshConnectionManager } = await import('../ssh-client');
    // Should not throw even if called multiple times
    sshConnectionManager.stopCleanup();
    sshConnectionManager.stopCleanup();
  });

  it('should clean up stale connections via startCleanup interval', async () => {
    jest.useFakeTimers();
    try {
      const { sshConnectionManager } = await import('../ssh-client');

      const config = createSSHConfig({ host: '10.0.0.90' });
      const client = new SSHClient(config);
      (client as any).connected = true;
      // Set lastUsed to more than TTL (60s) ago
      (client as any).lastUsed = Date.now() - 120_000;

      const internalClient = (client as any).client;
      spyOn(internalClient, 'end').mockImplementation(() => {});

      (sshConnectionManager as any).connections.set('root@10.0.0.90:22', client);

      // Restart cleanup to create a fresh interval under fake timers
      sshConnectionManager.stopCleanup();
      (sshConnectionManager as any).startCleanup();

      // Advance time past the 60s interval
      jest.advanceTimersByTime(61_000);

      // The stale client should be cleaned up
      expect((sshConnectionManager as any).connections.has('root@10.0.0.90:22')).toBe(false);

      sshConnectionManager.stopCleanup();
    } finally {
      jest.useRealTimers();
    }
  });

  it('should build SSH config for privateKeyPath auth', () => {
    const config = createSSHConfig({
      auth: {
        type: 'privateKey',
        username: 'admin',
        privateKeyPath: '/dev/null',
      },
    });
    const client = new SSHClient(config);
    const sshConfig = (client as any).buildSSHConfig();

    expect(sshConfig.username).toBe('admin');
    // privateKey should be read from the path (Buffer)
    expect(sshConfig.privateKey).toBeDefined();
    expect(sshConfig.passphrase).toBeUndefined();
  });
});

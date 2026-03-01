import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { loadZFSConfig } from '../zfs-config';

// Suppress console.error from loadZFSConfig warnings
const originalConsoleError = console.error;

function clearZfsEnv() {
  Object.keys(process.env).forEach((key) => {
    if (key.startsWith('ZFS_HOST')) {
      delete process.env[key];
    }
  });
}

describe('loadZFSConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    clearZfsEnv();
    console.error = mock(() => {});
  });

  afterEach(() => {
    clearZfsEnv();
    Object.assign(process.env, originalEnv);
    console.error = originalConsoleError;
  });

  it('should return empty hosts array when no hosts configured', () => {
    const config = loadZFSConfig();
    expect(config.hosts).toEqual([]);
  });

  it('should parse single host with defaults', () => {
    process.env.ZFS_HOST_1 = '192.168.1.50';
    process.env.ZFS_HOST_USER_1 = 'root';
    process.env.ZFS_HOST_KEY_PATH_1 = '/home/user/.ssh/id_rsa';

    const config = loadZFSConfig();

    expect(config.hosts.length).toBe(1);
    expect(config.hosts[0]).toEqual({
      host: '192.168.1.50',
      port: 22,
      name: '192.168.1.50',
      username: 'root',
      privateKeyPath: '/home/user/.ssh/id_rsa',
    });
  });

  it('should parse single host with custom port and name', () => {
    process.env.ZFS_HOST_1 = '192.168.1.50';
    process.env.ZFS_HOST_PORT_1 = '2222';
    process.env.ZFS_HOST_NAME_1 = 'nas-server';
    process.env.ZFS_HOST_USER_1 = 'admin';
    process.env.ZFS_HOST_PASSWORD_1 = 'secret123';

    const config = loadZFSConfig();

    expect(config.hosts.length).toBe(1);
    expect(config.hosts[0]).toEqual({
      host: '192.168.1.50',
      port: 2222,
      name: 'nas-server',
      username: 'admin',
      password: 'secret123',
    });
  });

  it('should parse multiple hosts', () => {
    process.env.ZFS_HOST_1 = '192.168.1.50';
    process.env.ZFS_HOST_USER_1 = 'root';
    process.env.ZFS_HOST_NAME_1 = 'nas1';
    process.env.ZFS_HOST_KEY_PATH_1 = '/keys/id_rsa';
    process.env.ZFS_HOST_2 = '192.168.1.51';
    process.env.ZFS_HOST_USER_2 = 'root';
    process.env.ZFS_HOST_NAME_2 = 'nas2';
    process.env.ZFS_HOST_KEY_PATH_2 = '/keys/id_rsa';

    const config = loadZFSConfig();

    expect(config.hosts.length).toBe(2);
    expect(config.hosts[0].name).toBe('nas1');
    expect(config.hosts[1].name).toBe('nas2');
  });

  it('should stop at first missing host when count not specified', () => {
    process.env.ZFS_HOST_1 = '192.168.1.50';
    process.env.ZFS_HOST_USER_1 = 'root';
    process.env.ZFS_HOST_KEY_PATH_1 = '/keys/id_rsa';
    process.env.ZFS_HOST_3 = '192.168.1.52'; // Skip 2
    process.env.ZFS_HOST_USER_3 = 'root';
    process.env.ZFS_HOST_KEY_PATH_3 = '/keys/id_rsa';

    const config = loadZFSConfig();

    expect(config.hosts.length).toBe(1);
    expect(config.hosts[0].host).toBe('192.168.1.50');
  });

  it('should continue with gaps when ZFS_HOST_COUNT is specified', () => {
    process.env.ZFS_HOST_COUNT = '3';
    process.env.ZFS_HOST_1 = '192.168.1.50';
    process.env.ZFS_HOST_USER_1 = 'root';
    process.env.ZFS_HOST_KEY_PATH_1 = '/keys/id_rsa';
    process.env.ZFS_HOST_3 = '192.168.1.52';
    process.env.ZFS_HOST_USER_3 = 'root';
    process.env.ZFS_HOST_KEY_PATH_3 = '/keys/id_rsa';

    const config = loadZFSConfig();

    expect(config.hosts.length).toBe(2);
    expect(config.hosts[0].host).toBe('192.168.1.50');
    expect(config.hosts[1].host).toBe('192.168.1.52');
  });

  it('should skip host with missing username and log warning', () => {
    process.env.ZFS_HOST_1 = '192.168.1.50';
    // No ZFS_HOST_USER_1 set
    process.env.ZFS_HOST_KEY_PATH_1 = '/keys/id_rsa';

    const config = loadZFSConfig();

    expect(config.hosts.length).toBe(0);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('ZFS_HOST_USER_1 is missing'),
    );
  });

  it('should support privateKey auth with passphrase', () => {
    process.env.ZFS_HOST_1 = '192.168.1.50';
    process.env.ZFS_HOST_USER_1 = 'root';
    process.env.ZFS_HOST_KEY_PATH_1 = '/keys/id_rsa';
    process.env.ZFS_HOST_KEY_PASSPHRASE_1 = 'my-passphrase';

    const config = loadZFSConfig();

    expect(config.hosts[0].privateKeyPath).toBe('/keys/id_rsa');
    expect(config.hosts[0].passphrase).toBe('my-passphrase');
    expect(config.hosts[0].password).toBeUndefined();
  });

  it('should support password auth', () => {
    process.env.ZFS_HOST_1 = '192.168.1.50';
    process.env.ZFS_HOST_USER_1 = 'root';
    process.env.ZFS_HOST_PASSWORD_1 = 'secret';

    const config = loadZFSConfig();

    expect(config.hosts[0].password).toBe('secret');
    expect(config.hosts[0].privateKeyPath).toBeUndefined();
  });
});

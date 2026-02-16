import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { loadProxmoxConfig } from '../proxmox-config';

describe('loadProxmoxConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.PROXMOX_HOST = 'pve.example.com';
    process.env.PROXMOX_PORT = '8006';
    process.env.PROXMOX_TOKEN_ID = 'root@pam!mytoken';
    process.env.PROXMOX_TOKEN_SECRET = '12345678-1234-1234-1234-1234567890ab';
    process.env.PROXMOX_ALLOW_SELF_SIGNED = 'true';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should load config from environment variables', () => {
    const config = loadProxmoxConfig();

    expect(config.host).toBe('pve.example.com');
    expect(config.port).toBe(8006);
    expect(config.tokenId).toBe('root@pam!mytoken');
    expect(config.tokenSecret).toBe('12345678-1234-1234-1234-1234567890ab');
    expect(config.allowSelfSignedCerts).toBe(true);
  });

  it('should use default port 8006', () => {
    delete process.env.PROXMOX_PORT;
    const config = loadProxmoxConfig();
    expect(config.port).toBe(8006);
  });

  it('should default allowSelfSignedCerts to true', () => {
    delete process.env.PROXMOX_ALLOW_SELF_SIGNED;
    const config = loadProxmoxConfig();
    expect(config.allowSelfSignedCerts).toBe(true);
  });

  it('should disable self-signed certs when PROXMOX_ALLOW_SELF_SIGNED=false', () => {
    process.env.PROXMOX_ALLOW_SELF_SIGNED = 'false';
    const config = loadProxmoxConfig();
    expect(config.allowSelfSignedCerts).toBe(false);
  });

  it('should throw on invalid port', () => {
    process.env.PROXMOX_PORT = '99999';
    expect(() => loadProxmoxConfig()).toThrow();
  });

  it('should accept custom port', () => {
    process.env.PROXMOX_PORT = '443';
    const config = loadProxmoxConfig();
    expect(config.port).toBe(443);
  });
});

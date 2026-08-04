import { describe, it, expect } from 'bun:test';
import { removeHostSchema, checkHostHealthSchema, verifyHostSchema, updateHostSchema } from '../schemas';

describe('removeHostSchema', () => {
  it('accepts positive integer', () => {
    expect(removeHostSchema.parse({ hostId: 1 }).hostId).toBe(1);
  });

  it('rejects zero, negative, non-integer', () => {
    expect(() => removeHostSchema.parse({ hostId: 0 })).toThrow();
    expect(() => removeHostSchema.parse({ hostId: -1 })).toThrow();
    expect(() => removeHostSchema.parse({ hostId: 1.5 })).toThrow();
  });
});

describe('checkHostHealthSchema', () => {
  it('accepts positive integer', () => {
    expect(checkHostHealthSchema.parse({ hostId: 7 }).hostId).toBe(7);
  });

  it('rejects invalid values', () => {
    expect(() => checkHostHealthSchema.parse({ hostId: 0 })).toThrow();
    expect(() => checkHostHealthSchema.parse({ hostId: -1 })).toThrow();
  });
});

describe('verifyHostSchema ssh target', () => {
  const base = { name: 'nas', agentUrl: 'https://agent.lan' };

  it('accepts an omitted, null, hostname, and IPv4 ssh host', () => {
    expect(verifyHostSchema.parse(base).sshHost).toBeUndefined();
    expect(verifyHostSchema.parse({ ...base, sshHost: null }).sshHost).toBeNull();
    expect(verifyHostSchema.parse({ ...base, sshHost: 'nas.lan' }).sshHost).toBe('nas.lan');
    expect(verifyHostSchema.parse({ ...base, sshHost: '192.168.1.50' }).sshHost).toBe('192.168.1.50');
  });

  it('trims surrounding whitespace on the ssh host and user', () => {
    const parsed = verifyHostSchema.parse({ ...base, sshHost: '  nas.lan  ', sshUser: '  deploy  ' });
    expect(parsed.sshHost).toBe('nas.lan');
    expect(parsed.sshUser).toBe('deploy');
  });

  it('rejects an ssh host carrying a scheme, port, path, credentials, or empty value', () => {
    const rejected = [
      'http://nas.lan',
      'nas.lan/api',
      'root@nas.lan',
      'nas lan',
      '',
      'nas.lan:2222',
      '192.168.1.50:22',
    ];
    for (const sshHost of rejected) {
      expect(() => verifyHostSchema.parse({ ...base, sshHost })).toThrow();
    }
  });

  it('accepts a bare IPv6 address', () => {
    expect(verifyHostSchema.parse({ ...base, sshHost: 'fe80::1' }).sshHost).toBe('fe80::1');
  });

  it('rejects an ssh user that is not a valid Linux username', () => {
    for (const sshUser of ['1root', 'has space', 'UPPER', '']) {
      expect(() => verifyHostSchema.parse({ ...base, sshUser })).toThrow();
    }
  });
});

describe('updateHostSchema ssh target', () => {
  it('accepts an ssh-only update with no name or agentUrl', () => {
    const parsed = updateHostSchema.parse({ hostId: 1, sshHost: '10.0.0.5' });
    expect(parsed.sshHost).toBe('10.0.0.5');
  });

  it('accepts null to clear the ssh target', () => {
    const parsed = updateHostSchema.parse({ hostId: 1, sshHost: null, sshUser: null });
    expect(parsed.sshHost).toBeNull();
    expect(parsed.sshUser).toBeNull();
  });

  it('still rejects an update with no fields at all', () => {
    expect(() => updateHostSchema.parse({ hostId: 1 })).toThrow();
  });
});

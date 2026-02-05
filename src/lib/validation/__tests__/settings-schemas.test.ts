import { describe, it, expect } from 'bun:test';
import {
  dockerSettingsSchema,
  dockerFormSchema,
  zfsSettingsSchema,
  zfsFormSchema,
  settingsSchema,
} from '../settings-schemas';

// ---------------------------------------------------------------------------
// Docker Settings Schema
// ---------------------------------------------------------------------------

describe('dockerSettingsSchema', () => {
  it('should accept valid docker settings', () => {
    const result = dockerSettingsSchema.safeParse({
      host: '192.168.1.100',
      port: 2375,
      protocol: 'http',
    });
    expect(result.success).toBe(true);
  });

  it('should accept https protocol', () => {
    const result = dockerSettingsSchema.safeParse({
      host: 'docker.local',
      port: 2376,
      protocol: 'https',
    });
    expect(result.success).toBe(true);
  });

  it('should reject empty host', () => {
    const result = dockerSettingsSchema.safeParse({
      host: '',
      port: 2375,
      protocol: 'http',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'host')).toBe(true);
    }
  });

  it('should reject host exceeding 253 characters', () => {
    const result = dockerSettingsSchema.safeParse({
      host: 'a'.repeat(254),
      port: 2375,
      protocol: 'http',
    });
    expect(result.success).toBe(false);
  });

  it('should reject port below 1', () => {
    const result = dockerSettingsSchema.safeParse({
      host: 'localhost',
      port: 0,
      protocol: 'http',
    });
    expect(result.success).toBe(false);
  });

  it('should reject port above 65535', () => {
    const result = dockerSettingsSchema.safeParse({
      host: 'localhost',
      port: 65536,
      protocol: 'http',
    });
    expect(result.success).toBe(false);
  });

  it('should reject non-integer port', () => {
    const result = dockerSettingsSchema.safeParse({
      host: 'localhost',
      port: 2375.5,
      protocol: 'http',
    });
    expect(result.success).toBe(false);
  });

  it('should reject invalid protocol', () => {
    const result = dockerSettingsSchema.safeParse({
      host: 'localhost',
      port: 2375,
      protocol: 'ftp',
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing fields', () => {
    const result = dockerSettingsSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('should accept boundary port values', () => {
    const resultMin = dockerSettingsSchema.safeParse({
      host: 'localhost',
      port: 1,
      protocol: 'http',
    });
    const resultMax = dockerSettingsSchema.safeParse({
      host: 'localhost',
      port: 65535,
      protocol: 'http',
    });
    expect(resultMin.success).toBe(true);
    expect(resultMax.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Docker Form Schema (string port → coerced number)
// ---------------------------------------------------------------------------

describe('dockerFormSchema', () => {
  it('should coerce string port to number', () => {
    const result = dockerFormSchema.safeParse({
      host: '192.168.1.100',
      port: '2375',
      protocol: 'http',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.port).toBe(2375);
    }
  });

  it('should reject empty port string', () => {
    const result = dockerFormSchema.safeParse({
      host: 'localhost',
      port: '',
      protocol: 'http',
    });
    expect(result.success).toBe(false);
  });

  it('should reject non-numeric port string', () => {
    const result = dockerFormSchema.safeParse({
      host: 'localhost',
      port: 'abc',
      protocol: 'http',
    });
    expect(result.success).toBe(false);
  });

  it('should reject port string that parses to out-of-range number', () => {
    const result = dockerFormSchema.safeParse({
      host: 'localhost',
      port: '99999',
      protocol: 'http',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ZFS Settings Schema
// ---------------------------------------------------------------------------

describe('zfsSettingsSchema', () => {
  describe('password auth', () => {
    it('should accept valid password auth settings', () => {
      const result = zfsSettingsSchema.safeParse({
        host: '192.168.1.200',
        port: 22,
        username: 'root',
        authType: 'password',
        password: 'secret123',
      });
      expect(result.success).toBe(true);
    });

    it('should reject password auth without password', () => {
      const result = zfsSettingsSchema.safeParse({
        host: '192.168.1.200',
        port: 22,
        username: 'root',
        authType: 'password',
        password: '',
      });
      expect(result.success).toBe(false);
    });

    it('should reject password auth with missing password field', () => {
      const result = zfsSettingsSchema.safeParse({
        host: '192.168.1.200',
        port: 22,
        username: 'root',
        authType: 'password',
      });
      expect(result.success).toBe(false);
    });

    it('should allow optional keyPath and passphrase with password auth', () => {
      const result = zfsSettingsSchema.safeParse({
        host: '192.168.1.200',
        port: 22,
        username: 'root',
        authType: 'password',
        password: 'secret',
        keyPath: '/some/path',
        passphrase: 'pass',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('privateKey auth', () => {
    it('should accept valid private key auth settings', () => {
      const result = zfsSettingsSchema.safeParse({
        host: '192.168.1.200',
        port: 22,
        username: 'root',
        authType: 'privateKey',
        keyPath: '/home/user/.ssh/id_rsa',
      });
      expect(result.success).toBe(true);
    });

    it('should accept private key auth with passphrase', () => {
      const result = zfsSettingsSchema.safeParse({
        host: '192.168.1.200',
        port: 22,
        username: 'root',
        authType: 'privateKey',
        keyPath: '/home/user/.ssh/id_rsa',
        passphrase: 'my-passphrase',
      });
      expect(result.success).toBe(true);
    });

    it('should reject private key auth without keyPath', () => {
      const result = zfsSettingsSchema.safeParse({
        host: '192.168.1.200',
        port: 22,
        username: 'root',
        authType: 'privateKey',
        keyPath: '',
      });
      expect(result.success).toBe(false);
    });

    it('should reject private key auth with missing keyPath field', () => {
      const result = zfsSettingsSchema.safeParse({
        host: '192.168.1.200',
        port: 22,
        username: 'root',
        authType: 'privateKey',
      });
      expect(result.success).toBe(false);
    });

    it('should allow optional password with privateKey auth', () => {
      const result = zfsSettingsSchema.safeParse({
        host: '192.168.1.200',
        port: 22,
        username: 'root',
        authType: 'privateKey',
        keyPath: '/home/user/.ssh/id_rsa',
        password: 'optional',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('shared fields', () => {
    it('should reject empty host', () => {
      const result = zfsSettingsSchema.safeParse({
        host: '',
        port: 22,
        username: 'root',
        authType: 'password',
        password: 'secret',
      });
      expect(result.success).toBe(false);
    });

    it('should reject host exceeding 253 characters', () => {
      const result = zfsSettingsSchema.safeParse({
        host: 'h'.repeat(254),
        port: 22,
        username: 'root',
        authType: 'password',
        password: 'secret',
      });
      expect(result.success).toBe(false);
    });

    it('should reject empty username', () => {
      const result = zfsSettingsSchema.safeParse({
        host: 'myhost',
        port: 22,
        username: '',
        authType: 'password',
        password: 'secret',
      });
      expect(result.success).toBe(false);
    });

    it('should reject username exceeding 256 characters', () => {
      const result = zfsSettingsSchema.safeParse({
        host: 'myhost',
        port: 22,
        username: 'u'.repeat(257),
        authType: 'password',
        password: 'secret',
      });
      expect(result.success).toBe(false);
    });

    it('should reject port below 1', () => {
      const result = zfsSettingsSchema.safeParse({
        host: 'myhost',
        port: 0,
        username: 'root',
        authType: 'password',
        password: 'secret',
      });
      expect(result.success).toBe(false);
    });

    it('should reject port above 65535', () => {
      const result = zfsSettingsSchema.safeParse({
        host: 'myhost',
        port: 65536,
        username: 'root',
        authType: 'password',
        password: 'secret',
      });
      expect(result.success).toBe(false);
    });

    it('should reject non-integer port', () => {
      const result = zfsSettingsSchema.safeParse({
        host: 'myhost',
        port: 22.5,
        username: 'root',
        authType: 'password',
        password: 'secret',
      });
      expect(result.success).toBe(false);
    });

    it('should reject invalid authType', () => {
      const result = zfsSettingsSchema.safeParse({
        host: 'myhost',
        port: 22,
        username: 'root',
        authType: 'agent',
        password: 'secret',
      });
      expect(result.success).toBe(false);
    });

    it('should accept boundary port values', () => {
      const resultMin = zfsSettingsSchema.safeParse({
        host: 'myhost',
        port: 1,
        username: 'root',
        authType: 'password',
        password: 'secret',
      });
      const resultMax = zfsSettingsSchema.safeParse({
        host: 'myhost',
        port: 65535,
        username: 'root',
        authType: 'password',
        password: 'secret',
      });
      expect(resultMin.success).toBe(true);
      expect(resultMax.success).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// ZFS Form Schema (string port → coerced number)
// ---------------------------------------------------------------------------

describe('zfsFormSchema', () => {
  it('should coerce string port to number for password auth', () => {
    const result = zfsFormSchema.safeParse({
      host: '192.168.1.200',
      port: '22',
      username: 'root',
      authType: 'password',
      password: 'secret',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.port).toBe(22);
    }
  });

  it('should coerce string port to number for privateKey auth', () => {
    const result = zfsFormSchema.safeParse({
      host: '192.168.1.200',
      port: '2222',
      username: 'admin',
      authType: 'privateKey',
      keyPath: '/home/admin/.ssh/id_rsa',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.port).toBe(2222);
    }
  });

  it('should reject empty port string', () => {
    const result = zfsFormSchema.safeParse({
      host: 'myhost',
      port: '',
      username: 'root',
      authType: 'password',
      password: 'secret',
    });
    expect(result.success).toBe(false);
  });

  it('should reject non-numeric port string', () => {
    const result = zfsFormSchema.safeParse({
      host: 'myhost',
      port: 'not-a-number',
      username: 'root',
      authType: 'password',
      password: 'secret',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Combined Settings Schema
// ---------------------------------------------------------------------------

describe('settingsSchema', () => {
  const validDocker = {
    host: '192.168.1.100',
    port: 2375,
    protocol: 'http' as const,
  };

  const validZfsPassword = {
    host: '192.168.1.200',
    port: 22,
    username: 'root',
    authType: 'password' as const,
    password: 'secret',
  };

  const validZfsKey = {
    host: '192.168.1.200',
    port: 22,
    username: 'root',
    authType: 'privateKey' as const,
    keyPath: '/home/user/.ssh/id_rsa',
  };

  it('should accept valid combined settings with password auth', () => {
    const result = settingsSchema.safeParse({
      docker: validDocker,
      zfs: validZfsPassword,
    });
    expect(result.success).toBe(true);
  });

  it('should accept valid combined settings with key auth', () => {
    const result = settingsSchema.safeParse({
      docker: validDocker,
      zfs: validZfsKey,
    });
    expect(result.success).toBe(true);
  });

  it('should reject when docker settings are invalid', () => {
    const result = settingsSchema.safeParse({
      docker: { ...validDocker, host: '' },
      zfs: validZfsPassword,
    });
    expect(result.success).toBe(false);
  });

  it('should reject when zfs settings are invalid', () => {
    const result = settingsSchema.safeParse({
      docker: validDocker,
      zfs: { ...validZfsPassword, password: '' },
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing docker section', () => {
    const result = settingsSchema.safeParse({
      zfs: validZfsPassword,
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing zfs section', () => {
    const result = settingsSchema.safeParse({
      docker: validDocker,
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty object', () => {
    const result = settingsSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

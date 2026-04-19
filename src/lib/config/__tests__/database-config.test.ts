import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { loadDatabaseConfig } from '../database-config';

describe('loadDatabaseConfig', () => {
  const originalEnv = { ...process.env };
  const KEYS = [
    'POSTGRES_HOST',
    'POSTGRES_PORT',
    'POSTGRES_DB',
    'POSTGRES_USER',
    'POSTGRES_PASSWORD',
    'POSTGRES_SSL',
    'POSTGRES_SSL_REJECT_UNAUTHORIZED',
    'POSTGRES_POOL_SIZE',
  ];

  beforeEach(() => {
    for (const key of KEYS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it('returns defaults when env vars are unset', () => {
    const config = loadDatabaseConfig();
    expect(config.host).toBe('localhost');
    expect(config.port).toBe(5432);
    expect(config.database).toBe('homelab');
    expect(config.user).toBe('homelab');
    expect(config.password).toBe('');
    expect(config.ssl).toBe(false);
    expect(config.sslRejectUnauthorized).toBe(true);
    expect(config.max).toBe(10);
  });

  it('reads custom values from env vars', () => {
    process.env.POSTGRES_HOST = 'db.example.com';
    process.env.POSTGRES_PORT = '15432';
    process.env.POSTGRES_DB = 'app';
    process.env.POSTGRES_USER = 'appuser';
    process.env.POSTGRES_PASSWORD = 'secret';
    process.env.POSTGRES_SSL = 'true';
    process.env.POSTGRES_POOL_SIZE = '25';

    const config = loadDatabaseConfig();
    expect(config.host).toBe('db.example.com');
    expect(config.port).toBe(15432);
    expect(config.database).toBe('app');
    expect(config.user).toBe('appuser');
    expect(config.password).toBe('secret');
    expect(config.ssl).toBe(true);
    expect(config.max).toBe(25);
  });

  describe('POSTGRES_SSL_REJECT_UNAUTHORIZED', () => {
    it('defaults to true when unset', () => {
      const config = loadDatabaseConfig();
      expect(config.sslRejectUnauthorized).toBe(true);
    });

    it('parses "false" as false', () => {
      process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED = 'false';
      const config = loadDatabaseConfig();
      expect(config.sslRejectUnauthorized).toBe(false);
    });

    it('parses "FALSE" (uppercase) as false', () => {
      process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED = 'FALSE';
      const config = loadDatabaseConfig();
      expect(config.sslRejectUnauthorized).toBe(false);
    });

    it('parses "true" as true', () => {
      process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED = 'true';
      const config = loadDatabaseConfig();
      expect(config.sslRejectUnauthorized).toBe(true);
    });

    it('parses "TRUE" (uppercase) as true', () => {
      process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED = 'TRUE';
      const config = loadDatabaseConfig();
      expect(config.sslRejectUnauthorized).toBe(true);
    });

    it('parses "1" as true', () => {
      process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED = '1';
      const config = loadDatabaseConfig();
      expect(config.sslRejectUnauthorized).toBe(true);
    });

    it('parses "0" as false', () => {
      process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED = '0';
      const config = loadDatabaseConfig();
      expect(config.sslRejectUnauthorized).toBe(false);
    });

    it('falls back to true for unrecognised values', () => {
      process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED = 'maybe';
      const config = loadDatabaseConfig();
      expect(config.sslRejectUnauthorized).toBe(true);
    });
  });
});

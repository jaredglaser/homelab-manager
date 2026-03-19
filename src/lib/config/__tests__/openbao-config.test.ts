import { describe, expect, test, afterEach } from 'bun:test';
import { loadOpenBaoConfig, isOpenBaoConfigured } from '@/lib/config/openbao-config';

describe('loadOpenBaoConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('loads config from environment variables', () => {
    process.env.OPENBAO_URL = 'http://openbao:8200';
    process.env.OPENBAO_TOKEN = 'dev-root-token';

    const config = loadOpenBaoConfig();
    expect(config.url).toBe('http://openbao:8200');
    expect(config.token).toBe('dev-root-token');
  });

  test('strips trailing slash from URL', () => {
    process.env.OPENBAO_URL = 'http://openbao:8200/';
    process.env.OPENBAO_TOKEN = 'dev-root-token';

    const config = loadOpenBaoConfig();
    expect(config.url).toBe('http://openbao:8200');
  });

  test('throws when OPENBAO_URL is missing', () => {
    delete process.env.OPENBAO_URL;
    process.env.OPENBAO_TOKEN = 'dev-root-token';

    expect(() => loadOpenBaoConfig()).toThrow();
  });

  test('throws when OPENBAO_TOKEN is missing', () => {
    process.env.OPENBAO_URL = 'http://openbao:8200';
    delete process.env.OPENBAO_TOKEN;

    expect(() => loadOpenBaoConfig()).toThrow();
  });

  test('throws for invalid URL format', () => {
    process.env.OPENBAO_URL = 'not-a-url';
    process.env.OPENBAO_TOKEN = 'dev-root-token';

    expect(() => loadOpenBaoConfig()).toThrow();
  });
});

describe('isOpenBaoConfigured', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('returns true when both OPENBAO_URL and OPENBAO_TOKEN are set', () => {
    process.env.OPENBAO_URL = 'http://openbao:8200';
    process.env.OPENBAO_TOKEN = 'dev-root-token';
    expect(isOpenBaoConfigured()).toBe(true);
  });

  test('returns false when OPENBAO_URL is not set', () => {
    delete process.env.OPENBAO_URL;
    process.env.OPENBAO_TOKEN = 'dev-root-token';
    expect(isOpenBaoConfigured()).toBe(false);
  });

  test('returns false when OPENBAO_URL is empty string', () => {
    process.env.OPENBAO_URL = '';
    process.env.OPENBAO_TOKEN = 'dev-root-token';
    expect(isOpenBaoConfigured()).toBe(false);
  });

  test('returns false when OPENBAO_TOKEN is not set', () => {
    process.env.OPENBAO_URL = 'http://openbao:8200';
    delete process.env.OPENBAO_TOKEN;
    expect(isOpenBaoConfigured()).toBe(false);
  });

  test('returns false when OPENBAO_TOKEN is empty string', () => {
    process.env.OPENBAO_URL = 'http://openbao:8200';
    process.env.OPENBAO_TOKEN = '';
    expect(isOpenBaoConfigured()).toBe(false);
  });
});

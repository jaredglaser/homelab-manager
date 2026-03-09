import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { loadPortainerConfig, isPortainerConfigured } from '../portainer-config';

describe('portainer-config', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.PORTAINER_URL = process.env.PORTAINER_URL;
    savedEnv.PORTAINER_TOKEN = process.env.PORTAINER_TOKEN;
    savedEnv.PORTAINER_ALLOW_SELF_SIGNED = process.env.PORTAINER_ALLOW_SELF_SIGNED;
    delete process.env.PORTAINER_URL;
    delete process.env.PORTAINER_TOKEN;
    delete process.env.PORTAINER_ALLOW_SELF_SIGNED;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  describe('loadPortainerConfig', () => {
    it('should return config when all required vars are set', () => {
      process.env.PORTAINER_URL = 'https://portainer.example.com:9443';
      process.env.PORTAINER_TOKEN = 'ptr_abc123';

      const config = loadPortainerConfig();

      expect(config).toEqual({
        url: 'https://portainer.example.com:9443',
        token: 'ptr_abc123',
        allowSelfSignedCerts: true,
      });
    });

    it('should default allowSelfSignedCerts to true', () => {
      process.env.PORTAINER_URL = 'https://portainer.local';
      process.env.PORTAINER_TOKEN = 'ptr_token';

      const config = loadPortainerConfig();

      expect(config.allowSelfSignedCerts).toBe(true);
    });

    it('should set allowSelfSignedCerts to false when explicitly disabled', () => {
      process.env.PORTAINER_URL = 'https://portainer.local';
      process.env.PORTAINER_TOKEN = 'ptr_token';
      process.env.PORTAINER_ALLOW_SELF_SIGNED = 'false';

      const config = loadPortainerConfig();

      expect(config.allowSelfSignedCerts).toBe(false);
    });
  });

  describe('isPortainerConfigured', () => {
    it('should return false when no vars are set', () => {
      expect(isPortainerConfigured()).toBe(false);
    });

    it('should return false when only URL is set', () => {
      process.env.PORTAINER_URL = 'https://portainer.local';

      expect(isPortainerConfigured()).toBe(false);
    });

    it('should return false when only TOKEN is set', () => {
      process.env.PORTAINER_TOKEN = 'ptr_token';

      expect(isPortainerConfigured()).toBe(false);
    });

    it('should return true when both URL and TOKEN are set', () => {
      process.env.PORTAINER_URL = 'https://portainer.local';
      process.env.PORTAINER_TOKEN = 'ptr_token';

      expect(isPortainerConfigured()).toBe(true);
    });
  });
});

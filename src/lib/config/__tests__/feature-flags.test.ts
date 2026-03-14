import { describe, it, expect, afterEach } from 'bun:test';
import { isDockerManagementEnabled } from '../feature-flags';

describe('feature-flags', () => {
  const originalEnv = process.env.DOCKER_MANAGEMENT_FEATURE_FLAG;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DOCKER_MANAGEMENT_FEATURE_FLAG;
    } else {
      process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = originalEnv;
    }
  });

  describe('isDockerManagementEnabled', () => {
    it('returns false when env var is not set', () => {
      delete process.env.DOCKER_MANAGEMENT_FEATURE_FLAG;
      expect(isDockerManagementEnabled()).toBe(false);
    });

    it('returns false when env var is empty string', () => {
      process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = '';
      expect(isDockerManagementEnabled()).toBe(false);
    });

    it('returns false when env var is "false"', () => {
      process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = 'false';
      expect(isDockerManagementEnabled()).toBe(false);
    });

    it('returns true when env var is "true"', () => {
      process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = 'true';
      expect(isDockerManagementEnabled()).toBe(true);
    });

    it('returns false for any other value', () => {
      process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = 'yes';
      expect(isDockerManagementEnabled()).toBe(false);
    });
  });
});

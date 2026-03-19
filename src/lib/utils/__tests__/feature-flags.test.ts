import { describe, it, expect, afterEach } from 'bun:test';

describe('isDockerManagementEnabledClient', () => {
  const originalEnv = import.meta.env.VITE_DOCKER_MANAGEMENT_FEATURE_FLAG;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete import.meta.env.VITE_DOCKER_MANAGEMENT_FEATURE_FLAG;
    } else {
      import.meta.env.VITE_DOCKER_MANAGEMENT_FEATURE_FLAG = originalEnv;
    }
  });

  it('returns true when flag is "true"', async () => {
    import.meta.env.VITE_DOCKER_MANAGEMENT_FEATURE_FLAG = 'true';
    const { isDockerManagementEnabledClient } = await import('../feature-flags');
    expect(isDockerManagementEnabledClient()).toBe(true);
  });

  it('returns false when flag is undefined', async () => {
    delete import.meta.env.VITE_DOCKER_MANAGEMENT_FEATURE_FLAG;
    const { isDockerManagementEnabledClient } = await import('../feature-flags');
    expect(isDockerManagementEnabledClient()).toBe(false);
  });

  it('returns false when flag is "false"', async () => {
    import.meta.env.VITE_DOCKER_MANAGEMENT_FEATURE_FLAG = 'false';
    const { isDockerManagementEnabledClient } = await import('../feature-flags');
    expect(isDockerManagementEnabledClient()).toBe(false);
  });
});

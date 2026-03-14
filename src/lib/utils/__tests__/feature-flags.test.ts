import { describe, it, expect, afterEach } from 'bun:test';

describe('isDockerManagementEnabled', () => {
  const originalEnv = import.meta.env.VITE_DOCKER_MANAGEMENT_FEATURE_FLAG;

  afterEach(() => {
    // Restore original value
    if (originalEnv === undefined) {
      delete import.meta.env.VITE_DOCKER_MANAGEMENT_FEATURE_FLAG;
    } else {
      import.meta.env.VITE_DOCKER_MANAGEMENT_FEATURE_FLAG = originalEnv;
    }
  });

  it('returns true when flag is "true"', async () => {
    import.meta.env.VITE_DOCKER_MANAGEMENT_FEATURE_FLAG = 'true';
    // Re-import to pick up new env value
    const { isDockerManagementEnabled } = await import('../feature-flags');
    expect(isDockerManagementEnabled()).toBe(true);
  });

  it('returns false when flag is undefined', async () => {
    delete import.meta.env.VITE_DOCKER_MANAGEMENT_FEATURE_FLAG;
    const { isDockerManagementEnabled } = await import('../feature-flags');
    expect(isDockerManagementEnabled()).toBe(false);
  });

  it('returns false when flag is "false"', async () => {
    import.meta.env.VITE_DOCKER_MANAGEMENT_FEATURE_FLAG = 'false';
    const { isDockerManagementEnabled } = await import('../feature-flags');
    expect(isDockerManagementEnabled()).toBe(false);
  });
});

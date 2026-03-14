import { describe, it, expect, afterEach } from 'bun:test';

/**
 * Server function tests for host management.
 *
 * These test exports, input validation schemas, and feature flag gating.
 * Full integration tests require a running database and are covered by
 * the E2E test suite.
 */
describe('hosts.functions module', () => {
  const originalEnv = process.env.DOCKER_MANAGEMENT_FEATURE_FLAG;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DOCKER_MANAGEMENT_FEATURE_FLAG;
    } else {
      process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = originalEnv;
    }
  });

  describe('exports', () => {
    it('exports addHost server function', async () => {
      const mod = await import('../hosts.functions');
      expect(mod.addHost).toBeDefined();
      expect(typeof mod.addHost).toBe('function');
    });

    it('exports removeHost server function', async () => {
      const mod = await import('../hosts.functions');
      expect(mod.removeHost).toBeDefined();
      expect(typeof mod.removeHost).toBe('function');
    });

    it('exports listHosts server function', async () => {
      const mod = await import('../hosts.functions');
      expect(mod.listHosts).toBeDefined();
      expect(typeof mod.listHosts).toBe('function');
    });

    it('exports updateAgent server function', async () => {
      const mod = await import('../hosts.functions');
      expect(mod.updateAgent).toBeDefined();
      expect(typeof mod.updateAgent).toBe('function');
    });

    it('exports checkHostHealth server function', async () => {
      const mod = await import('../hosts.functions');
      expect(mod.checkHostHealth).toBeDefined();
      expect(typeof mod.checkHostHealth).toBe('function');
    });
  });

  describe('feature flag gating', () => {
    it('addHost throws when feature flag is off', async () => {
      delete process.env.DOCKER_MANAGEMENT_FEATURE_FLAG;
      const mod = await import('../hosts.functions');
      await expect(
        mod.addHost({ data: { name: 'test', socketProxyUrl: 'tcp://192.168.1.10:2375' } })
      ).rejects.toThrow('Docker management feature is not enabled');
    });

    it('removeHost throws when feature flag is off', async () => {
      delete process.env.DOCKER_MANAGEMENT_FEATURE_FLAG;
      const mod = await import('../hosts.functions');
      await expect(
        mod.removeHost({ data: { hostId: 1 } })
      ).rejects.toThrow('Docker management feature is not enabled');
    });

    it('checkHostHealth throws when feature flag is off', async () => {
      delete process.env.DOCKER_MANAGEMENT_FEATURE_FLAG;
      const mod = await import('../hosts.functions');
      await expect(
        mod.checkHostHealth({ data: { hostId: 1 } })
      ).rejects.toThrow('Docker management feature is not enabled');
    });

    it('listHosts throws when feature flag is off', async () => {
      delete process.env.DOCKER_MANAGEMENT_FEATURE_FLAG;
      const mod = await import('../hosts.functions');
      await expect(
        mod.listHosts({})
      ).rejects.toThrow('Docker management feature is not enabled');
    });
  });

  describe('input validation', () => {
    it('addHost rejects empty name', async () => {
      process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = 'true';
      const mod = await import('../hosts.functions');
      await expect(
        mod.addHost({ data: { name: '', socketProxyUrl: 'tcp://192.168.1.10:2375' } })
      ).rejects.toThrow();
    });

    it('addHost rejects invalid socketProxyUrl scheme', async () => {
      process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = 'true';
      const mod = await import('../hosts.functions');
      await expect(
        mod.addHost({ data: { name: 'test', socketProxyUrl: 'ftp://192.168.1.10:2375' } })
      ).rejects.toThrow();
    });

    it('addHost accepts tcp:// socketProxyUrl', async () => {
      process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = 'true';
      const mod = await import('../hosts.functions');
      // Will fail at Dockerode connection, not at validation
      await expect(
        mod.addHost({ data: { name: 'test', socketProxyUrl: 'tcp://192.168.1.10:2375' } })
      ).rejects.not.toThrow(/scheme/);
    });

    it('removeHost rejects non-positive hostId', async () => {
      process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = 'true';
      const mod = await import('../hosts.functions');
      await expect(
        mod.removeHost({ data: { hostId: 0 } })
      ).rejects.toThrow();
    });
  });
});

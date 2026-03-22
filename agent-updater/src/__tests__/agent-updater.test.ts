import { describe, expect, test, mock, beforeAll } from 'bun:test';
import { AgentUpdater } from '../agent-updater';
import type { AgentUpdaterConfig } from '../agent-updater';
import type { HealthReporter } from '../health-reporter';

beforeAll(() => {
  console.info = mock(() => {});
  console.error = mock(() => {});
});

function createMockHealthReporter(healthy = true): HealthReporter {
  return {
    checkAgentHealth: mock(() => Promise.resolve(healthy)),
  } as unknown as HealthReporter;
}

const defaultConfig: AgentUpdaterConfig = {
  containerName: 'hlm-agent',
  imageName: 'ghcr.io/org/agent:latest',
  checkIntervalMs: 60_000,
  healthCheckMaxAttempts: 1,
  healthCheckIntervalMs: 0,
};

function createMockContainerInfo(overrides: Record<string, unknown> = {}) {
  return {
    Image: 'sha256:abc123',
    Config: {
      Image: 'ghcr.io/org/agent:latest',
      Env: ['AGENT_TOKEN=secret', 'AGENT_PORT=9090'],
      ExposedPorts: { '9090/tcp': {} },
      Labels: { app: 'hlm-agent' },
    },
    HostConfig: {
      Binds: ['/var/run/docker.sock:/var/run/docker.sock'],
    },
    NetworkSettings: {
      Networks: {
        bridge: { IPAddress: '172.17.0.2' },
      },
    },
    State: {
      Running: true,
      Health: { Status: 'healthy' },
    },
    ...overrides,
  };
}

function createMockPull() {
  return mock(
    (_imageName: string, cb: (err: Error | null, stream: NodeJS.ReadableStream) => void) => {
      cb(null, {} as NodeJS.ReadableStream);
    }
  );
}

function createMockModem() {
  return {
    followProgress: mock(
      (_stream: NodeJS.ReadableStream, cb: (err: Error | null) => void) => {
        cb(null);
      }
    ),
  };
}

describe('AgentUpdater', () => {
  describe('checkForUpdate', () => {
    test('returns updateAvailable true when digests differ', async () => {
      const containerInfo = createMockContainerInfo({
        Image: 'sha256:old-digest',
      });

      const mockContainer = {
        inspect: mock(() => Promise.resolve(containerInfo)),
      };
      const mockImage = {
        distribution: mock(() =>
          Promise.resolve({
            Descriptor: { digest: 'sha256:new-digest' },
          })
        ),
      };
      const mockDocker = {
        getContainer: mock(() => mockContainer),
        getImage: mock(() => mockImage),
      };

      const updater = new AgentUpdater(mockDocker as any, defaultConfig, createMockHealthReporter());
      const result = await updater.checkForUpdate();

      expect(result.updateAvailable).toBe(true);
      expect(result.currentDigest).toBe('sha256:old-digest');
      expect(result.remoteDigest).toBe('sha256:new-digest');
    });

    test('returns updateAvailable false when digests match', async () => {
      const containerInfo = createMockContainerInfo({
        Image: 'ghcr.io/org/agent@sha256:same-digest',
      });

      const mockContainer = {
        inspect: mock(() => Promise.resolve(containerInfo)),
      };
      const mockImage = {
        distribution: mock(() =>
          Promise.resolve({
            Descriptor: { digest: 'sha256:same-digest' },
          })
        ),
      };
      const mockDocker = {
        getContainer: mock(() => mockContainer),
        getImage: mock(() => mockImage),
      };

      const updater = new AgentUpdater(mockDocker as any, defaultConfig, createMockHealthReporter());
      const result = await updater.checkForUpdate();

      expect(result.updateAvailable).toBe(false);
      expect(result.currentDigest).toBe('sha256:same-digest');
      expect(result.remoteDigest).toBe('sha256:same-digest');
    });

    test('returns updateAvailable false when check fails', async () => {
      const mockContainer = {
        inspect: mock(() => Promise.reject(new Error('container not found'))),
      };
      const mockDocker = {
        getContainer: mock(() => mockContainer),
        getImage: mock(() => ({})),
      };

      const updater = new AgentUpdater(mockDocker as any, defaultConfig, createMockHealthReporter());
      const result = await updater.checkForUpdate();

      expect(result.updateAvailable).toBe(false);
    });

    test('returns updateAvailable false when remote digest is missing', async () => {
      const containerInfo = createMockContainerInfo();
      const mockContainer = {
        inspect: mock(() => Promise.resolve(containerInfo)),
      };
      const mockImage = {
        distribution: mock(() => Promise.resolve({ Descriptor: {} })),
      };
      const mockDocker = {
        getContainer: mock(() => mockContainer),
        getImage: mock(() => mockImage),
      };

      const updater = new AgentUpdater(mockDocker as any, defaultConfig, createMockHealthReporter());
      const result = await updater.checkForUpdate();

      expect(result.updateAvailable).toBe(false);
      expect(result.currentDigest).toBe('sha256:abc123');
    });
  });

  describe('performUpdate', () => {
    test('pulls new image, stops old container, recreates, and verifies health', async () => {
      const containerInfo = createMockContainerInfo();
      const newContainerInfo = createMockContainerInfo({
        State: { Running: true, Health: { Status: 'healthy' } },
      });

      const mockOldContainer = {
        inspect: mock(() => Promise.resolve(containerInfo)),
        stop: mock(() => Promise.resolve()),
        remove: mock(() => Promise.resolve()),
      };
      const mockNewContainer = {
        start: mock(() => Promise.resolve()),
        inspect: mock(() => Promise.resolve(newContainerInfo)),
      };

      const mockDocker = {
        getContainer: mock(() => mockOldContainer),
        pull: createMockPull(),
        modem: createMockModem(),
        createContainer: mock(() => Promise.resolve(mockNewContainer)),
      };

      const mockHealthReporter = createMockHealthReporter();
      const updater = new AgentUpdater(mockDocker as any, defaultConfig, mockHealthReporter);
      const result = await updater.performUpdate();

      expect(result.success).toBe(true);
      expect(result.previousImage).toBe('ghcr.io/org/agent:latest');
      expect(result.newImage).toBe('ghcr.io/org/agent:latest');
      expect(mockOldContainer.stop).toHaveBeenCalledTimes(1);
      expect(mockOldContainer.remove).toHaveBeenCalledTimes(1);
      expect(mockNewContainer.start).toHaveBeenCalledTimes(1);
      expect(mockDocker.createContainer).toHaveBeenCalledTimes(1);
      expect(mockHealthReporter.checkAgentHealth).toHaveBeenCalledTimes(1);
    });

    test('considers container healthy when no healthcheck is defined and running', async () => {
      const containerInfo = createMockContainerInfo();
      const noHealthcheckInfo = createMockContainerInfo({
        State: { Running: true },
      });

      const mockOldContainer = {
        inspect: mock(() => Promise.resolve(containerInfo)),
        stop: mock(() => Promise.resolve()),
        remove: mock(() => Promise.resolve()),
      };
      const mockNewContainer = {
        start: mock(() => Promise.resolve()),
        inspect: mock(() => Promise.resolve(noHealthcheckInfo)),
      };

      const mockDocker = {
        getContainer: mock(() => mockOldContainer),
        pull: createMockPull(),
        modem: createMockModem(),
        createContainer: mock(() => Promise.resolve(mockNewContainer)),
      };

      const updater = new AgentUpdater(mockDocker as any, defaultConfig, createMockHealthReporter());
      const result = await updater.performUpdate();

      expect(result.success).toBe(true);
    });

    test('rolls back to previous image if health check fails after recreate', async () => {
      const containerInfo = createMockContainerInfo({
        Config: {
          ...createMockContainerInfo().Config,
          Image: 'ghcr.io/org/agent:v1',
        },
      });

      const unhealthyInfo = createMockContainerInfo({
        State: { Running: true, Health: { Status: 'unhealthy' } },
      });

      const mockOldContainer = {
        inspect: mock(() => Promise.resolve(containerInfo)),
        stop: mock(() => Promise.resolve()),
        remove: mock(() => Promise.resolve()),
      };

      const mockUnhealthyContainer = {
        start: mock(() => Promise.resolve()),
        inspect: mock(() => Promise.resolve(unhealthyInfo)),
        stop: mock(() => Promise.resolve()),
        remove: mock(() => Promise.resolve()),
      };

      const mockRollbackContainer = {
        start: mock(() => Promise.resolve()),
      };

      let createCallCount = 0;

      const mockDocker = {
        getContainer: mock(() => mockOldContainer),
        pull: createMockPull(),
        modem: createMockModem(),
        createContainer: mock(() => {
          createCallCount++;
          if (createCallCount === 1) {
            return Promise.resolve(mockUnhealthyContainer);
          }
          return Promise.resolve(mockRollbackContainer);
        }),
      };

      const config: AgentUpdaterConfig = {
        ...defaultConfig,
        imageName: 'ghcr.io/org/agent:v2',
      };

      const updater = new AgentUpdater(mockDocker as any, config, createMockHealthReporter());
      const result = await updater.performUpdate();

      expect(result.success).toBe(false);
      expect(result.previousImage).toBe('ghcr.io/org/agent:v1');
      expect(result.newImage).toBe('ghcr.io/org/agent:v2');
      expect(result.error).toBe('Health check failed after update');
      expect(result.rolledBack).toBe(true);
      expect(mockDocker.createContainer).toHaveBeenCalledTimes(2);
      expect(mockRollbackContainer.start).toHaveBeenCalledTimes(1);
    });

    test('handles rollback when failed container stop/remove throws', async () => {
      const containerInfo = createMockContainerInfo({
        Config: {
          ...createMockContainerInfo().Config,
          Image: 'ghcr.io/org/agent:v1',
        },
      });

      const unhealthyInfo = createMockContainerInfo({
        State: { Running: true, Health: { Status: 'unhealthy' } },
      });

      const mockOldContainer = {
        inspect: mock(() => Promise.resolve(containerInfo)),
        stop: mock(() => Promise.resolve()),
        remove: mock(() => Promise.resolve()),
      };

      const mockUnhealthyContainer = {
        start: mock(() => Promise.resolve()),
        inspect: mock(() => Promise.resolve(unhealthyInfo)),
        stop: mock(() => Promise.reject(new Error('already stopped'))),
        remove: mock(() => Promise.reject(new Error('already removed'))),
      };

      const mockRollbackContainer = {
        start: mock(() => Promise.resolve()),
      };

      let createCallCount = 0;

      const mockDocker = {
        getContainer: mock(() => mockOldContainer),
        pull: createMockPull(),
        modem: createMockModem(),
        createContainer: mock(() => {
          createCallCount++;
          if (createCallCount === 1) {
            return Promise.resolve(mockUnhealthyContainer);
          }
          return Promise.resolve(mockRollbackContainer);
        }),
      };

      const config: AgentUpdaterConfig = {
        ...defaultConfig,
        imageName: 'ghcr.io/org/agent:v2',
      };

      const updater = new AgentUpdater(mockDocker as any, config, createMockHealthReporter());
      const result = await updater.performUpdate();

      expect(result.success).toBe(false);
      expect(result.rolledBack).toBe(true);
      expect(mockRollbackContainer.start).toHaveBeenCalledTimes(1);
    });

    test('returns error when pull fails', async () => {
      const containerInfo = createMockContainerInfo();
      const mockOldContainer = {
        inspect: mock(() => Promise.resolve(containerInfo)),
      };

      const pullCallback = mock(
        (_imageName: string, cb: (err: Error | null, stream: NodeJS.ReadableStream) => void) => {
          cb(new Error('pull failed: unauthorized'), null as unknown as NodeJS.ReadableStream);
        }
      );

      const mockDocker = {
        getContainer: mock(() => mockOldContainer),
        pull: pullCallback,
        modem: createMockModem(),
      };

      const updater = new AgentUpdater(mockDocker as any, defaultConfig, createMockHealthReporter());
      const result = await updater.performUpdate();

      expect(result.success).toBe(false);
      expect(result.error).toBe('pull failed: unauthorized');
    });

    test('returns error when followProgress reports error', async () => {
      const containerInfo = createMockContainerInfo();
      const mockOldContainer = {
        inspect: mock(() => Promise.resolve(containerInfo)),
      };

      const mockDocker = {
        getContainer: mock(() => mockOldContainer),
        pull: createMockPull(),
        modem: {
          followProgress: mock(
            (_stream: NodeJS.ReadableStream, cb: (err: Error | null) => void) => {
              cb(new Error('download interrupted'));
            }
          ),
        },
      };

      const updater = new AgentUpdater(mockDocker as any, defaultConfig, createMockHealthReporter());
      const result = await updater.performUpdate();

      expect(result.success).toBe(false);
      expect(result.error).toBe('download interrupted');
    });

    test('handles inspect failure during health check', async () => {
      const containerInfo = createMockContainerInfo();

      const mockOldContainer = {
        inspect: mock(() => Promise.resolve(containerInfo)),
        stop: mock(() => Promise.resolve()),
        remove: mock(() => Promise.resolve()),
      };

      const mockRollbackContainer = {
        start: mock(() => Promise.resolve()),
      };

      const mockNewContainer = {
        start: mock(() => Promise.resolve()),
        inspect: mock(() => Promise.reject(new Error('inspect failed'))),
        stop: mock(() => Promise.resolve()),
        remove: mock(() => Promise.resolve()),
      };

      let createCallCount = 0;
      const mockDocker = {
        getContainer: mock(() => mockOldContainer),
        pull: createMockPull(),
        modem: createMockModem(),
        createContainer: mock(() => {
          createCallCount++;
          if (createCallCount === 1) {
            return Promise.resolve(mockNewContainer);
          }
          return Promise.resolve(mockRollbackContainer);
        }),
      };

      const updater = new AgentUpdater(mockDocker as any, defaultConfig, createMockHealthReporter());
      const result = await updater.performUpdate();

      expect(result.success).toBe(false);
      expect(result.rolledBack).toBe(true);
    });

    test('rolls back when Docker health passes but HTTP health check fails', async () => {
      const containerInfo = createMockContainerInfo({
        Config: {
          ...createMockContainerInfo().Config,
          Image: 'ghcr.io/org/agent:v1',
        },
      });
      const healthyDockerInfo = createMockContainerInfo({
        State: { Running: true, Health: { Status: 'healthy' } },
      });

      const mockOldContainer = {
        inspect: mock(() => Promise.resolve(containerInfo)),
        stop: mock(() => Promise.resolve()),
        remove: mock(() => Promise.resolve()),
      };

      const mockNewContainer = {
        start: mock(() => Promise.resolve()),
        inspect: mock(() => Promise.resolve(healthyDockerInfo)),
        stop: mock(() => Promise.resolve()),
        remove: mock(() => Promise.resolve()),
      };

      const mockRollbackContainer = {
        start: mock(() => Promise.resolve()),
      };

      let createCallCount = 0;

      const mockDocker = {
        getContainer: mock(() => mockOldContainer),
        pull: createMockPull(),
        modem: createMockModem(),
        createContainer: mock(() => {
          createCallCount++;
          if (createCallCount === 1) {
            return Promise.resolve(mockNewContainer);
          }
          return Promise.resolve(mockRollbackContainer);
        }),
      };

      const config: AgentUpdaterConfig = {
        ...defaultConfig,
        imageName: 'ghcr.io/org/agent:v2',
      };

      const mockHealthReporter = createMockHealthReporter(false);
      const updater = new AgentUpdater(mockDocker as any, config, mockHealthReporter);
      const result = await updater.performUpdate();

      expect(result.success).toBe(false);
      expect(result.previousImage).toBe('ghcr.io/org/agent:v1');
      expect(result.newImage).toBe('ghcr.io/org/agent:v2');
      expect(result.error).toBe('Agent HTTP health check failed after update');
      expect(result.rolledBack).toBe(true);
      expect(mockDocker.createContainer).toHaveBeenCalledTimes(2);
      expect(mockRollbackContainer.start).toHaveBeenCalledTimes(1);
      expect(mockHealthReporter.checkAgentHealth).toHaveBeenCalledTimes(1);
    });
  });
});

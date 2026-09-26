import { describe, expect, test, mock, beforeAll, afterAll } from 'bun:test';
import type Dockerode from 'dockerode';
import { AgentUpdater, deriveHealthWaitParams } from '../agent-updater';
import type { AgentUpdaterConfig } from '../agent-updater';
import type { HealthReporter } from '../health-reporter';

const originalConsoleInfo = console.info;
const originalConsoleError = console.error;

beforeAll(() => {
  console.info = mock(() => {});
  console.error = mock(() => {});
});

afterAll(() => {
  console.info = originalConsoleInfo;
  console.error = originalConsoleError;
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

function createMockImageInspect(repoDigests: string[] = ['ghcr.io/org/agent@sha256:v1digest']) {
  return {
    inspect: mock(() => Promise.resolve({ RepoDigests: repoDigests, Config: {} })),
  };
}

function createMockDockerWithImages(overrides: Record<string, unknown> = {}) {
  return {
    getContainer: mock(() => ({})),
    pull: createMockPull(),
    modem: createMockModem(),
    createContainer: mock(() => Promise.resolve({})),
    getImage: mock(() => createMockImageInspect()),
    ...overrides,
  };
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
        Image: 'sha256:old-image-id',
      });

      const mockContainer = {
        inspect: mock(() => Promise.resolve(containerInfo)),
      };
      const mockLocalImage = {
        inspect: mock(() =>
          Promise.resolve({
            RepoDigests: ['ghcr.io/org/agent@sha256:old-digest'],
          })
        ),
      };
      const mockRemoteImage = {
        distribution: mock(() =>
          Promise.resolve({
            Descriptor: { digest: 'sha256:new-digest' },
          })
        ),
      };
      let getImageCallCount = 0;
      const mockDocker = {
        getContainer: mock(() => mockContainer),
        getImage: mock(() => {
          getImageCallCount++;
          if (getImageCallCount === 1) return mockLocalImage;
          return mockRemoteImage;
        }),
      };

      const updater = new AgentUpdater(mockDocker as any, defaultConfig, createMockHealthReporter());
      const result = await updater.checkForUpdate();

      expect(result.updateAvailable).toBe(true);
      expect(result.currentDigest).toBe('sha256:old-digest');
      expect(result.remoteDigest).toBe('sha256:new-digest');
    });

    test('returns updateAvailable false when digests match', async () => {
      const containerInfo = createMockContainerInfo({
        Image: 'sha256:some-image-id',
      });

      const mockContainer = {
        inspect: mock(() => Promise.resolve(containerInfo)),
      };
      const mockLocalImage = {
        inspect: mock(() =>
          Promise.resolve({
            RepoDigests: ['ghcr.io/org/agent@sha256:same-digest'],
          })
        ),
      };
      const mockRemoteImage = {
        distribution: mock(() =>
          Promise.resolve({
            Descriptor: { digest: 'sha256:same-digest' },
          })
        ),
      };
      let getImageCallCount = 0;
      const mockDocker = {
        getContainer: mock(() => mockContainer),
        getImage: mock(() => {
          getImageCallCount++;
          if (getImageCallCount === 1) return mockLocalImage;
          return mockRemoteImage;
        }),
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
      const mockLocalImage = {
        inspect: mock(() =>
          Promise.resolve({
            RepoDigests: ['ghcr.io/org/agent@sha256:abc123'],
          })
        ),
      };
      const mockRemoteImage = {
        distribution: mock(() => Promise.resolve({ Descriptor: {} })),
      };
      let getImageCallCount = 0;
      const mockDocker = {
        getContainer: mock(() => mockContainer),
        getImage: mock(() => {
          getImageCallCount++;
          if (getImageCallCount === 1) return mockLocalImage;
          return mockRemoteImage;
        }),
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
        getImage: mock(() => createMockImageInspect()),
        pull: createMockPull(),
        modem: createMockModem(),
        createContainer: mock(() => Promise.resolve(mockNewContainer)),
      };

      const mockHealthReporter = createMockHealthReporter();
      const updater = new AgentUpdater(mockDocker as any, defaultConfig, mockHealthReporter);
      const result = await updater.performUpdate();

      expect(result.success).toBe(true);
      expect(result.previousImage).toBe('ghcr.io/org/agent@sha256:v1digest');
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
        getImage: mock(() => createMockImageInspect()),
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
        getImage: mock(() => createMockImageInspect()),
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
      expect(result.previousImage).toBe('ghcr.io/org/agent@sha256:v1digest');
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
        getImage: mock(() => createMockImageInspect()),
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
        getImage: mock(() => createMockImageInspect()),
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
        getImage: mock(() => createMockImageInspect()),
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
        getImage: mock(() => createMockImageInspect()),
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

    test('returns rolledBack false when rollback itself fails', async () => {
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

      let createCallCount = 0;

      const mockDocker = {
        getContainer: mock(() => mockOldContainer),
        getImage: mock(() => createMockImageInspect()),
        pull: createMockPull(),
        modem: createMockModem(),
        createContainer: mock(() => {
          createCallCount++;
          if (createCallCount === 1) {
            return Promise.resolve(mockUnhealthyContainer);
          }
          return Promise.reject(new Error('no space left on device'));
        }),
      };

      const config: AgentUpdaterConfig = {
        ...defaultConfig,
        imageName: 'ghcr.io/org/agent:v2',
      };

      const updater = new AgentUpdater(mockDocker as any, config, createMockHealthReporter());
      const result = await updater.performUpdate();

      expect(result.success).toBe(false);
      expect(result.rolledBack).toBe(false);
      expect(result.error).toBe('Health check failed after update');
    });

    test('attempts rollback after mid-update failure when teardown completed', async () => {
      const containerInfo = createMockContainerInfo({
        Config: {
          ...createMockContainerInfo().Config,
          Image: 'ghcr.io/org/agent:v1',
        },
      });

      const mockOldContainer = {
        inspect: mock(() => Promise.resolve(containerInfo)),
        stop: mock(() => Promise.resolve()),
        remove: mock(() => Promise.resolve()),
      };

      const mockRollbackContainer = {
        start: mock(() => Promise.resolve()),
      };

      let createCallCount = 0;

      const mockDocker = {
        getContainer: mock(() => mockOldContainer),
        getImage: mock(() => createMockImageInspect()),
        pull: createMockPull(),
        modem: createMockModem(),
        createContainer: mock(() => {
          createCallCount++;
          if (createCallCount === 1) {
            return Promise.reject(new Error('create failed'));
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
      expect(result.error).toBe('create failed');
      expect(result.rolledBack).toBe(true);
      expect(mockDocker.createContainer).toHaveBeenCalledTimes(2);
      expect(mockRollbackContainer.start).toHaveBeenCalledTimes(1);
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
        getImage: mock(() => createMockImageInspect()),
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
      expect(result.previousImage).toBe('ghcr.io/org/agent@sha256:v1digest');
      expect(result.newImage).toBe('ghcr.io/org/agent:v2');
      expect(result.error).toBe('Agent HTTP health check failed after update');
      expect(result.rolledBack).toBe(true);
      expect(mockDocker.createContainer).toHaveBeenCalledTimes(2);
      expect(mockRollbackContainer.start).toHaveBeenCalledTimes(1);
      expect(mockHealthReporter.checkAgentHealth).toHaveBeenCalledTimes(1);
    });

    test('rolls back onto the previous image digest, not the tag', async () => {
      const containerInfo = createMockContainerInfo();
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
      const mockRollbackContainer = { start: mock(() => Promise.resolve()) };

      const createdImages: string[] = [];
      const mockDocker = createMockDockerWithImages({
        getContainer: mock(() => mockOldContainer),
        createContainer: mock((options: Dockerode.ContainerCreateOptions) => {
          createdImages.push(options.Image as string);
          if (createdImages.length === 1) {
            return Promise.resolve(mockUnhealthyContainer);
          }
          return Promise.resolve(mockRollbackContainer);
        }),
      });

      const config: AgentUpdaterConfig = {
        ...defaultConfig,
        imageName: 'ghcr.io/org/agent:v2',
      };
      const updater = new AgentUpdater(mockDocker as any, config, createMockHealthReporter());
      const result = await updater.performUpdate();

      expect(result.success).toBe(false);
      expect(result.rolledBack).toBe(true);
      expect(createdImages[0]).toBe('ghcr.io/org/agent:v2');
      expect(createdImages[1]).toBe('ghcr.io/org/agent@sha256:v1digest');
    });

    test('falls back to the immutable image ID when no repo digest exists', async () => {
      const containerInfo = createMockContainerInfo();
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
      const mockRollbackContainer = { start: mock(() => Promise.resolve()) };

      const createdImages: string[] = [];
      const mockDocker = createMockDockerWithImages({
        getContainer: mock(() => mockOldContainer),
        getImage: mock(() => createMockImageInspect([])),
        createContainer: mock((options: Dockerode.ContainerCreateOptions) => {
          createdImages.push(options.Image as string);
          if (createdImages.length === 1) {
            return Promise.resolve(mockUnhealthyContainer);
          }
          return Promise.resolve(mockRollbackContainer);
        }),
      });

      const updater = new AgentUpdater(mockDocker as any, defaultConfig, createMockHealthReporter());
      const result = await updater.performUpdate();

      expect(result.rolledBack).toBe(true);
      expect(result.previousImage).toBe('sha256:abc123');
      expect(createdImages[1]).toBe('sha256:abc123');
    });

    test('drops AGENT_VERSION from the preserved env so the new image default applies', async () => {
      const containerInfo = createMockContainerInfo({
        Config: {
          ...createMockContainerInfo().Config,
          Env: ['AGENT_TOKEN=secret', 'AGENT_PORT=9090', 'AGENT_VERSION=9.0.0'],
        },
      });
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

      let createdEnv: string[] | undefined;
      const mockDocker = createMockDockerWithImages({
        getContainer: mock(() => mockOldContainer),
        createContainer: mock((options: Dockerode.ContainerCreateOptions) => {
          createdEnv = options.Env as string[];
          return Promise.resolve(mockNewContainer);
        }),
      });

      const updater = new AgentUpdater(mockDocker as any, defaultConfig, createMockHealthReporter());
      const result = await updater.performUpdate();

      expect(result.success).toBe(true);
      expect(createdEnv).toBeDefined();
      expect(createdEnv).not.toContain('AGENT_VERSION=9.0.0');
      expect(createdEnv).toContain('AGENT_TOKEN=secret');
      expect(createdEnv).toContain('AGENT_PORT=9090');
    });

    test('waits long enough for a slow healthcheck to report before rolling back', async () => {
      const containerInfo = createMockContainerInfo();
      let inspectCount = 0;
      const startingThenHealthyInfo = () => {
        inspectCount++;
        if (inspectCount <= 15) {
          return Promise.resolve(
            createMockContainerInfo({ State: { Running: true, Health: { Status: 'starting' } } })
          );
        }
        return Promise.resolve(
          createMockContainerInfo({ State: { Running: true, Health: { Status: 'healthy' } } })
        );
      };

      const mockOldContainer = {
        inspect: mock(() => Promise.resolve(containerInfo)),
        stop: mock(() => Promise.resolve()),
        remove: mock(() => Promise.resolve()),
      };
      const mockNewContainer = {
        start: mock(() => Promise.resolve()),
        inspect: mock(startingThenHealthyInfo),
      };

      const mockDocker = createMockDockerWithImages({
        getContainer: mock(() => mockOldContainer),
        createContainer: mock(() => Promise.resolve(mockNewContainer)),
        getImage: mock((name: string) => {
          if (name === defaultConfig.imageName) {
            return {
              inspect: mock(() =>
                Promise.resolve({
                  RepoDigests: ['ghcr.io/org/agent@sha256:v2digest'],
                  Config: { Healthcheck: { Interval: 50_000_000, Retries: 3, StartPeriod: 0 } },
                })
              ),
            };
          }
          return createMockImageInspect();
        }),
      });

      // No explicit healthCheckMaxAttempts/intervalMs: the window must come
      // from the image healthcheck config, not the old 10x3s default.
      const config: AgentUpdaterConfig = {
        containerName: 'hlm-agent',
        imageName: defaultConfig.imageName,
        checkIntervalMs: 60_000,
      };
      const updater = new AgentUpdater(mockDocker as any, config, createMockHealthReporter());
      const result = await updater.performUpdate();

      expect(result.success).toBe(true);
      expect(inspectCount).toBeGreaterThan(10);
    });
  });

  describe('deriveHealthWaitParams', () => {
    test('returns the fixed 30s fallback when there is no healthcheck', () => {
      expect(deriveHealthWaitParams(undefined)).toEqual({ maxAttempts: 10, intervalMs: 3000 });
      expect(deriveHealthWaitParams({})).toEqual({ maxAttempts: 10, intervalMs: 3000 });
    });

    test('covers at least two full intervals plus retries for a 30s healthcheck', () => {
      const params = deriveHealthWaitParams({ Interval: 30_000_000_000, Retries: 3, StartPeriod: 0 });
      const windowMs = params.maxAttempts * params.intervalMs;
      expect(windowMs).toBeGreaterThanOrEqual(2 * 30_000);
      expect(windowMs).toBeGreaterThanOrEqual(30_000 * (3 + 1));
      expect(params.intervalMs).toBeLessThanOrEqual(3000);
    });

    test('adds the start period to the window', () => {
      const withStart = deriveHealthWaitParams({
        Interval: 10_000_000_000,
        StartPeriod: 30_000_000_000,
        Retries: 3,
      });
      const withoutStart = deriveHealthWaitParams({ Interval: 10_000_000_000, Retries: 3 });
      expect(withStart.maxAttempts).toBeGreaterThan(withoutStart.maxAttempts);
    });

    test('defaults retries to 3 when unset', () => {
      const params = deriveHealthWaitParams({ Interval: 30_000_000_000 });
      const windowMs = params.maxAttempts * params.intervalMs;
      expect(windowMs).toBeGreaterThanOrEqual(30_000 * (3 + 1));
    });
  });
});

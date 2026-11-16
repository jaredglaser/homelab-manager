import { describe, it, expect } from 'bun:test';
import type Dockerode from 'dockerode';
import { scheduleSelfRestart } from '../self-restart';
import { waitForCondition } from '../test/wait-for-condition';

interface FakeContainer {
  restart: () => Promise<void>;
  restartCalls: number;
}

function fakeDocker(): { docker: Dockerode; containers: Map<string, FakeContainer> } {
  const containers = new Map<string, FakeContainer>();
  const docker = {
    getContainer: (name: string): FakeContainer => {
      let container = containers.get(name);
      if (!container) {
        container = {
          restartCalls: 0,
          restart: () => {
            container!.restartCalls += 1;
            return Promise.resolve();
          },
        };
        containers.set(name, container);
      }
      return container;
    },
  } as unknown as Dockerode;
  return { docker, containers };
}

describe('scheduleSelfRestart', () => {
  it('returns false without scheduling anything when Docker is unavailable', () => {
    expect(scheduleSelfRestart(null, 'hlm-agent', 1)).toBe(false);
  });

  it('restarts the named container after the delay and reports true', async () => {
    const { docker, containers } = fakeDocker();
    expect(scheduleSelfRestart(docker, 'hlm-agent', 1)).toBe(true);
    await waitForCondition(() => (containers.get('hlm-agent')?.restartCalls ?? 0) === 1, {
      timeoutMs: 2000,
      message: 'self-restart never fired',
    });
    expect(containers.get('hlm-agent')?.restartCalls).toBe(1);
  });

  it('catches a docker restart rejection inside the scheduled callback', async () => {
    // Bun fails the test on an unhandled rejection, so this doubles as proof
    // that the rejection cannot escape the callback and kill the agent before
    // the restart (or a later provisioning retry) can run.
    let restartCalls = 0;
    const docker = {
      getContainer: () => ({
        restart: () => {
          restartCalls += 1;
          return Promise.reject(new Error('socket proxy down'));
        },
      }),
    } as unknown as Dockerode;
    expect(scheduleSelfRestart(docker, 'hlm-agent', 1)).toBe(true);
    await waitForCondition(() => restartCalls === 1, {
      timeoutMs: 2000,
      message: 'the rejecting restart never fired',
    });
  });
});

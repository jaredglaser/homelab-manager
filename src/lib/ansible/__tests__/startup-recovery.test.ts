import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import type { AnsibleBroadcastEvent } from '@/lib/ansible/run-broadcast-service';
import {
  performAnsibleRunRecovery,
  type AnsibleStartupRecoveryRepo,
  type AnsibleWatchdogController,
} from '../startup-recovery';

function createRepo(overrides: Partial<AnsibleStartupRecoveryRepo> = {}): AnsibleStartupRecoveryRepo {
  return {
    failStrandedRuns: mock().mockResolvedValue([]) as unknown as AnsibleStartupRecoveryRepo['failStrandedRuns'],
    timeoutStuckRuns: mock().mockResolvedValue([]) as unknown as AnsibleStartupRecoveryRepo['timeoutStuckRuns'],
    ...overrides,
  };
}

function createWatchdog(): AnsibleWatchdogController & { startMock: ReturnType<typeof mock> } {
  const startMock = mock();
  return {
    start: startMock as unknown as AnsibleWatchdogController['start'],
    startMock,
  };
}

function createPublishRecorder() {
  const events: AnsibleBroadcastEvent[] = [];
  return {
    events,
    publish: (event: AnsibleBroadcastEvent) => {
      events.push(event);
    },
  };
}

describe('performAnsibleRunRecovery', () => {
  let setTimeoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Fire retry()'s abortableSleep synchronously so tests don't wait on real timers.
    setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: TimerHandler,
      _delay?: number,
    ) => {
      if (typeof fn === 'function') fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
  });

  it('starts the watchdog with the repo and publish function when no rows are recovered', async () => {
    const repo = createRepo();
    const watchdog = createWatchdog();
    const recorder = createPublishRecorder();

    await performAnsibleRunRecovery(repo, watchdog, recorder.publish);

    expect(repo.failStrandedRuns).toHaveBeenCalledTimes(1);
    expect(recorder.events).toEqual([]);
    expect(watchdog.startMock).toHaveBeenCalledTimes(1);
    expect(watchdog.startMock).toHaveBeenCalledWith(repo, recorder.publish);
  });

  it('publishes a failed run_finished for each recovered run', async () => {
    const repo = createRepo({
      failStrandedRuns: mock().mockResolvedValue([
        { id: 1, runId: 'run-a' },
        { id: 2, runId: 'run-b' },
      ]) as unknown as AnsibleStartupRecoveryRepo['failStrandedRuns'],
    });
    const recorder = createPublishRecorder();
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});

    await performAnsibleRunRecovery(repo, createWatchdog(), recorder.publish);

    expect(recorder.events).toEqual([
      { type: 'run_finished', runId: 'run-a', status: 'failed' },
      { type: 'run_finished', runId: 'run-b', status: 'failed' },
    ]);
    expect(String(infoSpy.mock.calls.at(-1)?.[0])).toContain('run-a, run-b');
    infoSpy.mockRestore();
  });

  it('swallows per-row publish errors and continues the loop', async () => {
    const repo = createRepo({
      failStrandedRuns: mock().mockResolvedValue([
        { id: 1, runId: 'run-a' },
        { id: 2, runId: 'run-b' },
      ]) as unknown as AnsibleStartupRecoveryRepo['failStrandedRuns'],
    });
    const seen: string[] = [];
    const publish = mock((event: AnsibleBroadcastEvent) => {
      seen.push(event.runId);
      if (event.runId === 'run-a') throw new Error('subscriber blew up');
    });
    const watchdog = createWatchdog();
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {});

    await performAnsibleRunRecovery(repo, watchdog, publish);

    expect(seen).toEqual(['run-a', 'run-b']);
    expect(watchdog.startMock).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('retries failStrandedRuns on transient failure and succeeds', async () => {
    const failStrandedRuns = mock()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([]);
    const repo = createRepo({
      failStrandedRuns: failStrandedRuns as unknown as AnsibleStartupRecoveryRepo['failStrandedRuns'],
    });
    const watchdog = createWatchdog();
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});

    await performAnsibleRunRecovery(repo, watchdog, createPublishRecorder().publish);

    expect(failStrandedRuns).toHaveBeenCalledTimes(2);
    expect(watchdog.startMock).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('gives up after maxAttempts and still starts the watchdog', async () => {
    const failStrandedRuns = mock().mockRejectedValue(new Error('db down'));
    const repo = createRepo({
      failStrandedRuns: failStrandedRuns as unknown as AnsibleStartupRecoveryRepo['failStrandedRuns'],
    });
    const watchdog = createWatchdog();
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});

    await performAnsibleRunRecovery(repo, watchdog, createPublishRecorder().publish);

    expect(failStrandedRuns).toHaveBeenCalledTimes(3);
    expect(watchdog.startMock).toHaveBeenCalledTimes(1);
    const messages = errSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('exhausted after 3 attempts'))).toBe(true);
    errSpy.mockRestore();
  });

  it('passes the signal option through to retry() so shutdown short-circuits the loop', async () => {
    const controller = new AbortController();
    controller.abort();
    const failStrandedRuns = mock().mockRejectedValue(new Error('boom'));
    const repo = createRepo({
      failStrandedRuns: failStrandedRuns as unknown as AnsibleStartupRecoveryRepo['failStrandedRuns'],
    });
    const watchdog = createWatchdog();
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});

    await performAnsibleRunRecovery(repo, watchdog, createPublishRecorder().publish, {
      signal: controller.signal,
    });

    expect(failStrandedRuns).toHaveBeenCalledTimes(1);
    expect(watchdog.startMock).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});

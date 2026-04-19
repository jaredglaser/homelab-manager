import { describe, it, expect, mock, spyOn } from 'bun:test';
import {
  performStartupRecovery,
  type StartupRecoveryRepo,
  type WatchdogController,
} from '../startup-recovery';

function createRepo(overrides: Partial<StartupRecoveryRepo> = {}): StartupRecoveryRepo {
  return {
    recoverStuckDeploys: mock().mockResolvedValue([]) as unknown as StartupRecoveryRepo['recoverStuckDeploys'],
    timeoutStuckDeploys: mock().mockResolvedValue([]) as unknown as StartupRecoveryRepo['timeoutStuckDeploys'],
    notifyStackChange: mock().mockResolvedValue(undefined) as unknown as StartupRecoveryRepo['notifyStackChange'],
    ...overrides,
  };
}

function createWatchdog(): WatchdogController & { startMock: ReturnType<typeof mock> } {
  const startMock = mock();
  return {
    start: startMock as unknown as WatchdogController['start'],
    startMock,
  };
}

describe('performStartupRecovery', () => {
  it('starts the watchdog when no rows are recovered', async () => {
    const repo = createRepo();
    const watchdog = createWatchdog();

    await performStartupRecovery(repo, watchdog);

    expect(repo.recoverStuckDeploys).toHaveBeenCalledTimes(1);
    expect(repo.notifyStackChange).not.toHaveBeenCalled();
    expect(watchdog.startMock).toHaveBeenCalledTimes(1);
    expect(watchdog.startMock).toHaveBeenCalledWith(repo);
  });

  it('passes the STARTUP_RECOVERY_MESSAGE mentioning restart and re-trigger guidance', async () => {
    const recoverStuckDeploys = mock().mockResolvedValue([]);
    const repo = createRepo({
      recoverStuckDeploys: recoverStuckDeploys as unknown as StartupRecoveryRepo['recoverStuckDeploys'],
    });

    await performStartupRecovery(repo, createWatchdog());

    const [msg] = recoverStuckDeploys.mock.calls[0] as [string];
    expect(msg).toContain('server restarted');
    expect(msg).toContain('verify');
  });

  it('notifies each recovered row on stack_change with correct args', async () => {
    const recovered = [
      { id: 1, stack: 'plex', host: 'home' },
      { id: 2, stack: 'traefik', host: 'home' },
    ];
    const notifyStackChange = mock().mockResolvedValue(undefined);
    const repo = createRepo({
      recoverStuckDeploys: mock().mockResolvedValue(recovered) as unknown as StartupRecoveryRepo['recoverStuckDeploys'],
      notifyStackChange: notifyStackChange as unknown as StartupRecoveryRepo['notifyStackChange'],
    });

    await performStartupRecovery(repo, createWatchdog());

    expect(notifyStackChange).toHaveBeenCalledTimes(2);
    expect(notifyStackChange.mock.calls[0]).toEqual(['plex', 'home']);
    expect(notifyStackChange.mock.calls[1]).toEqual(['traefik', 'home']);
  });

  it('swallows per-row notify errors and continues the loop', async () => {
    const recovered = [
      { id: 1, stack: 'a', host: 'h' },
      { id: 2, stack: 'b', host: 'h' },
    ];
    const notifyStackChange = mock()
      .mockRejectedValueOnce(new Error('notify blew up'))
      .mockResolvedValueOnce(undefined);
    const repo = createRepo({
      recoverStuckDeploys: mock().mockResolvedValue(recovered) as unknown as StartupRecoveryRepo['recoverStuckDeploys'],
      notifyStackChange: notifyStackChange as unknown as StartupRecoveryRepo['notifyStackChange'],
    });
    const watchdog = createWatchdog();
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});

    await performStartupRecovery(repo, watchdog);

    expect(notifyStackChange).toHaveBeenCalledTimes(2);
    expect(notifyStackChange.mock.calls[1]).toEqual(['b', 'h']);
    expect(watchdog.startMock).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('retries recoverStuckDeploys on transient failure and succeeds', async () => {
    const recoverStuckDeploys = mock()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([]);
    const repo = createRepo({
      recoverStuckDeploys: recoverStuckDeploys as unknown as StartupRecoveryRepo['recoverStuckDeploys'],
    });
    const watchdog = createWatchdog();
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});

    await performStartupRecovery(repo, watchdog, {
      maxAttempts: 3,
      backoffMs: () => 0,
      sleep: async () => {},
    });

    expect(recoverStuckDeploys).toHaveBeenCalledTimes(2);
    expect(watchdog.startMock).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('gives up after maxAttempts and still starts the watchdog', async () => {
    const recoverStuckDeploys = mock().mockRejectedValue(new Error('db down'));
    const repo = createRepo({
      recoverStuckDeploys: recoverStuckDeploys as unknown as StartupRecoveryRepo['recoverStuckDeploys'],
    });
    const watchdog = createWatchdog();
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});

    await performStartupRecovery(repo, watchdog, {
      maxAttempts: 3,
      backoffMs: () => 0,
      sleep: async () => {},
    });

    expect(recoverStuckDeploys).toHaveBeenCalledTimes(3);
    expect(watchdog.startMock).toHaveBeenCalledTimes(1);
    const messages = errSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('exhausted after 3 attempts'))).toBe(true);
    errSpy.mockRestore();
  });

  it('sleeps between retry attempts using the provided backoff', async () => {
    const sleep = mock().mockResolvedValue(undefined);
    const backoffMs = mock().mockImplementation((attempt: number) => 100 * (attempt + 1));
    const repo = createRepo({
      recoverStuckDeploys: mock()
        .mockRejectedValueOnce(new Error('1'))
        .mockRejectedValueOnce(new Error('2'))
        .mockResolvedValueOnce([]) as unknown as StartupRecoveryRepo['recoverStuckDeploys'],
    });
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});

    await performStartupRecovery(repo, createWatchdog(), {
      maxAttempts: 3,
      backoffMs: backoffMs as unknown as (attempt: number) => number,
      sleep: sleep as unknown as (ms: number) => Promise<void>,
    });

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[0][0]).toBe(100);
    expect(sleep.mock.calls[1][0]).toBe(200);
    errSpy.mockRestore();
  });
});

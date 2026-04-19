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
    findSucceededPostSuccessDeploys: mock().mockResolvedValue([]) as unknown as StartupRecoveryRepo['findSucceededPostSuccessDeploys'],
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

  describe('orphaned manifest-delete sweep', () => {
    it('removes stacks still in manifest that have succeeded postSuccess rows', async () => {
      const findSucceededPostSuccessDeploys = mock().mockResolvedValue([
        { id: 10, stack: 'orphan-1', host: 'home' },
        { id: 11, stack: 'orphan-2', host: 'home' },
      ]);
      const repo = createRepo({
        findSucceededPostSuccessDeploys: findSucceededPostSuccessDeploys as unknown as StartupRecoveryRepo['findSucceededPostSuccessDeploys'],
      });
      const removeStackFromManifest = mock().mockResolvedValue({ commitSha: 'x' });
      const manifestReader = {
        listStackNames: mock().mockResolvedValue(new Set(['orphan-1', 'orphan-2'])),
      };

      await performStartupRecovery(repo, createWatchdog(), {
        maxAttempts: 1,
        backoffMs: () => 0,
        sleep: async () => {},
        manifestReader,
        stackRepoWriter: { removeStackFromManifest: removeStackFromManifest as unknown as (s: string) => Promise<{ commitSha: string }> },
      });

      expect(findSucceededPostSuccessDeploys).toHaveBeenCalledWith('removeFromManifest');
      expect(removeStackFromManifest).toHaveBeenCalledTimes(2);
      expect(removeStackFromManifest.mock.calls[0]).toEqual(['orphan-1']);
      expect(removeStackFromManifest.mock.calls[1]).toEqual(['orphan-2']);
    });

    it('skips rows whose stack is already gone from the manifest', async () => {
      const repo = createRepo({
        findSucceededPostSuccessDeploys: mock().mockResolvedValue([
          { id: 10, stack: 'ghost', host: 'home' },
        ]) as unknown as StartupRecoveryRepo['findSucceededPostSuccessDeploys'],
      });
      const removeStackFromManifest = mock();
      const manifestReader = {
        listStackNames: mock().mockResolvedValue(new Set<string>()), // empty — ghost isn't there
      };

      await performStartupRecovery(repo, createWatchdog(), {
        maxAttempts: 1,
        backoffMs: () => 0,
        sleep: async () => {},
        manifestReader,
        stackRepoWriter: { removeStackFromManifest: removeStackFromManifest as unknown as (s: string) => Promise<{ commitSha: string }> },
      });

      expect(removeStackFromManifest).not.toHaveBeenCalled();
    });

    it('continues after a per-stack failure', async () => {
      const repo = createRepo({
        findSucceededPostSuccessDeploys: mock().mockResolvedValue([
          { id: 10, stack: 'a', host: 'home' },
          { id: 11, stack: 'b', host: 'home' },
        ]) as unknown as StartupRecoveryRepo['findSucceededPostSuccessDeploys'],
      });
      const removeStackFromManifest = mock()
        .mockRejectedValueOnce(new Error('disk full'))
        .mockResolvedValueOnce({ commitSha: 'x' });
      const manifestReader = {
        listStackNames: mock().mockResolvedValue(new Set(['a', 'b'])),
      };
      const errSpy = spyOn(console, 'error').mockImplementation(() => {});

      await performStartupRecovery(repo, createWatchdog(), {
        maxAttempts: 1,
        backoffMs: () => 0,
        sleep: async () => {},
        manifestReader,
        stackRepoWriter: { removeStackFromManifest: removeStackFromManifest as unknown as (s: string) => Promise<{ commitSha: string }> },
      });

      expect(removeStackFromManifest).toHaveBeenCalledTimes(2);
      errSpy.mockRestore();
    });

    it('deduplicates multiple succeeded rows for the same stack', async () => {
      const repo = createRepo({
        findSucceededPostSuccessDeploys: mock().mockResolvedValue([
          { id: 10, stack: 'dup', host: 'home' },
          { id: 11, stack: 'dup', host: 'home' },
          { id: 12, stack: 'dup', host: 'home' },
        ]) as unknown as StartupRecoveryRepo['findSucceededPostSuccessDeploys'],
      });
      const removeStackFromManifest = mock().mockResolvedValue({ commitSha: 'x' });
      const manifestReader = {
        listStackNames: mock().mockResolvedValue(new Set(['dup'])),
      };

      await performStartupRecovery(repo, createWatchdog(), {
        maxAttempts: 1,
        backoffMs: () => 0,
        sleep: async () => {},
        manifestReader,
        stackRepoWriter: { removeStackFromManifest: removeStackFromManifest as unknown as (s: string) => Promise<{ commitSha: string }> },
      });

      expect(removeStackFromManifest).toHaveBeenCalledTimes(1);
    });

    it('skips the sweep entirely when manifestReader or writer is omitted', async () => {
      const findSucceededPostSuccessDeploys = mock().mockResolvedValue([
        { id: 10, stack: 'plex', host: 'home' },
      ]);
      const repo = createRepo({
        findSucceededPostSuccessDeploys: findSucceededPostSuccessDeploys as unknown as StartupRecoveryRepo['findSucceededPostSuccessDeploys'],
      });

      await performStartupRecovery(repo, createWatchdog(), {
        maxAttempts: 1,
        backoffMs: () => 0,
        sleep: async () => {},
      });

      expect(findSucceededPostSuccessDeploys).not.toHaveBeenCalled();
    });

    it('starts the watchdog even if the sweep throws', async () => {
      const repo = createRepo({
        findSucceededPostSuccessDeploys: mock().mockRejectedValue(new Error('db down')) as unknown as StartupRecoveryRepo['findSucceededPostSuccessDeploys'],
      });
      const watchdog = createWatchdog();
      const manifestReader = {
        listStackNames: mock().mockResolvedValue(new Set<string>()),
      };
      const errSpy = spyOn(console, 'error').mockImplementation(() => {});

      await performStartupRecovery(repo, watchdog, {
        maxAttempts: 1,
        backoffMs: () => 0,
        sleep: async () => {},
        manifestReader,
        stackRepoWriter: { removeStackFromManifest: (async () => ({ commitSha: 'x' })) },
      });

      expect(watchdog.startMock).toHaveBeenCalledTimes(1);
      errSpy.mockRestore();
    });

    it('aborts the sweep and logs when listStackNames throws', async () => {
      const repo = createRepo({
        findSucceededPostSuccessDeploys: mock().mockResolvedValue([
          { id: 10, stack: 'plex', host: 'home' },
        ]) as unknown as StartupRecoveryRepo['findSucceededPostSuccessDeploys'],
      });
      const removeStackFromManifest = mock().mockResolvedValue({ commitSha: 'x' });
      const manifestReader = {
        listStackNames: mock().mockRejectedValue(new Error('git read error')),
      };
      const errSpy = spyOn(console, 'error').mockImplementation(() => {});
      const watchdog = createWatchdog();

      await performStartupRecovery(repo, watchdog, {
        maxAttempts: 1,
        backoffMs: () => 0,
        sleep: async () => {},
        manifestReader,
        stackRepoWriter: { removeStackFromManifest: removeStackFromManifest as unknown as (s: string) => Promise<{ commitSha: string }> },
      });

      // Should not attempt any manifest delete
      expect(removeStackFromManifest).not.toHaveBeenCalled();
      // Watchdog still starts
      expect(watchdog.startMock).toHaveBeenCalledTimes(1);
      const messages = errSpy.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('Failed to read manifest'))).toBe(true);
      errSpy.mockRestore();
    });
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

  it('uses default backoff and sleep when no options are provided', async () => {
    // Spy on setTimeout to fire synchronously so the default sleep resolves immediately.
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      ((fn: TimerHandler) => {
        if (typeof fn === 'function') fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
    );

    const recoverStuckDeploys = mock()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce([]) as unknown as StartupRecoveryRepo['recoverStuckDeploys'];
    const repo = createRepo({ recoverStuckDeploys });
    const watchdog = createWatchdog();
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      // Calling without options exercises the default backoffMs and sleep inline functions.
      await performStartupRecovery(repo, watchdog);

      expect(recoverStuckDeploys).toHaveBeenCalledTimes(2);
      expect(watchdog.startMock).toHaveBeenCalledTimes(1);
    } finally {
      setTimeoutSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

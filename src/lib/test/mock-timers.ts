import { spyOn } from 'bun:test';

export interface CapturedTimer {
  fn: () => void | Promise<void>;
  delayMs: number;
  readonly id: number;
  cleared: boolean;
  fired: boolean;
}

export interface TimerMockOptions {
  fireImmediately?: boolean;
  onSchedule?: (timer: CapturedTimer) => void;
}

export interface TimerMock {
  readonly scheduled: readonly CapturedTimer[];
  readonly delays: readonly number[];
  readonly pending: readonly CapturedTimer[];
  readonly setSpy: ReturnType<typeof spyOn>;
  readonly clearSpy: ReturnType<typeof spyOn>;
  fire(timer: CapturedTimer): void | Promise<void>;
  fireNext(): boolean;
  restore(): void;
}

// Restore before any waitFor/waitForCondition: both poll via setTimeout/setInterval and a captured poll never fires.
function installTimerMock(
  setKind: 'setInterval' | 'setTimeout',
  clearKind: 'clearInterval' | 'clearTimeout',
  options: TimerMockOptions,
): TimerMock {
  const { fireImmediately = false, onSchedule } = options;
  const scheduled: CapturedTimer[] = [];
  let nextId = 1;

  const setSpy = spyOn(globalThis, setKind).mockImplementation(
    ((fn: TimerHandler, delay?: number) => {
      const timer: CapturedTimer = {
        fn: typeof fn === 'function' ? (fn as () => void) : () => {},
        delayMs: delay ?? 0,
        id: nextId++,
        cleared: false,
        fired: false,
      };
      scheduled.push(timer);
      onSchedule?.(timer);
      if (fireImmediately) fire(timer);
      return timer.id as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval,
  );
  // Handles minted before the mock window must still clear for real.
  const realClear = globalThis[clearKind];
  const clearSpy = spyOn(globalThis, clearKind).mockImplementation(
    ((id?: number | object) => {
      const timer = scheduled.find((t) => t.id === (id as unknown as number));
      if (timer) timer.cleared = true;
      else (realClear as (handle: unknown) => void)(id);
    }) as unknown as typeof clearInterval,
  );

  function fire(timer: CapturedTimer): void | Promise<void> {
    timer.fired = true;
    return timer.fn();
  }

  return {
    scheduled,
    get delays() {
      return scheduled.map((t) => t.delayMs);
    },
    get pending() {
      return scheduled.filter((t) => !t.fired && !t.cleared);
    },
    setSpy,
    clearSpy,
    fire,
    fireNext(): boolean {
      const timer = scheduled.find((t) => !t.fired && !t.cleared);
      if (!timer) return false;
      fire(timer);
      return true;
    },
    restore(): void {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    },
  };
}

export function mockSetTimeout(options: TimerMockOptions = {}): TimerMock {
  return installTimerMock('setTimeout', 'clearTimeout', options);
}

export function mockSetInterval(options: TimerMockOptions = {}): TimerMock {
  return installTimerMock('setInterval', 'clearInterval', options);
}

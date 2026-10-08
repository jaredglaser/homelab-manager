import { describe, it, expect } from 'bun:test';
import { mockSetTimeout, mockSetInterval, type CapturedTimer } from '../mock-timers';

describe('mockSetTimeout', () => {
  it('records delays in schedule order and returns correlatable handles', () => {
    const timers = mockSetTimeout();
    try {
      const a = setTimeout(() => {}, 1000);
      const b = setTimeout(() => {}, 2000);
      expect(timers.delays).toEqual([1000, 2000]);
      expect(timers.scheduled.map((t) => t.id)).toEqual([a as unknown as number, b as unknown as number]);
    } finally {
      timers.restore();
    }
  });

  it('capture mode leaves callbacks pending until fired explicitly', () => {
    const timers = mockSetTimeout();
    try {
      const calls: string[] = [];
      setTimeout(() => calls.push('first'), 10);
      setTimeout(() => calls.push('second'), 20);
      expect(calls).toEqual([]);
      expect(timers.pending).toHaveLength(2);

      expect(timers.fireNext()).toBe(true);
      expect(calls).toEqual(['first']);
      expect(timers.pending).toHaveLength(1);

      expect(timers.fireNext()).toBe(true);
      expect(calls).toEqual(['first', 'second']);
      expect(timers.fireNext()).toBe(false);
    } finally {
      timers.restore();
    }
  });

  it('fire runs one specific captured timer', () => {
    const timers = mockSetTimeout();
    try {
      const calls: string[] = [];
      setTimeout(() => calls.push('first'), 10);
      setTimeout(() => calls.push('second'), 20);
      timers.fire(timers.scheduled[1]);
      expect(calls).toEqual(['second']);
    } finally {
      timers.restore();
    }
  });

  it('fire returns the callback result so async callbacks can be awaited', async () => {
    const timers = mockSetTimeout();
    try {
      let done = false;
      setTimeout(async () => {
        await Promise.resolve();
        done = true;
      }, 10);
      await timers.fire(timers.scheduled[0]);
      expect(done).toBe(true);
    } finally {
      timers.restore();
    }
  });

  it('fireImmediately runs callbacks inline and leaves nothing pending', () => {
    const timers = mockSetTimeout({ fireImmediately: true });
    try {
      const calls: string[] = [];
      setTimeout(() => calls.push('now'), 1000);
      expect(calls).toEqual(['now']);
      expect(timers.pending).toHaveLength(0);
      expect(timers.delays).toEqual([1000]);
    } finally {
      timers.restore();
    }
  });

  it('clearTimeout marks the timer cleared and drops it from pending', () => {
    const timers = mockSetTimeout();
    try {
      const calls: string[] = [];
      const handle = setTimeout(() => calls.push('never'), 10);
      expect(timers.pending).toHaveLength(1);
      clearTimeout(handle);
      expect(timers.pending).toHaveLength(0);
      expect(timers.scheduled[0].cleared).toBe(true);
      expect(timers.fireNext()).toBe(false);
      expect(calls).toEqual([]);
    } finally {
      timers.restore();
    }
  });

  it('onSchedule sees each timer before fireImmediately runs it', () => {
    const order: string[] = [];
    const timers = mockSetTimeout({
      fireImmediately: true,
      onSchedule: (timer: CapturedTimer) => {
        order.push(`schedule:${timer.delayMs}`);
      },
    });
    try {
      setTimeout(() => order.push('fire'), 500);
      expect(order).toEqual(['schedule:500', 'fire']);
    } finally {
      timers.restore();
    }
  });

  it('restore puts the real timers back', () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const timers = mockSetTimeout();
    expect(globalThis.setTimeout).not.toBe(realSetTimeout);
    timers.restore();
    expect(globalThis.setTimeout).toBe(realSetTimeout);
    expect(globalThis.clearTimeout).toBe(realClearTimeout);
  });
});

describe('mockSetInterval', () => {
  it('captures interval ticks for manual firing and tracks clearInterval', () => {
    const timers = mockSetInterval();
    try {
      const ticks: number[] = [];
      const handle = setInterval(() => ticks.push(1), 100);
      expect(timers.delays).toEqual([100]);
      expect(ticks).toEqual([]);

      timers.fireNext();
      timers.fire(timers.scheduled[0]);
      expect(ticks).toEqual([1, 1]);

      clearInterval(handle);
      expect(timers.scheduled[0].cleared).toBe(true);
    } finally {
      timers.restore();
    }
  });

  it('fireImmediately runs interval callbacks inline', () => {
    const timers = mockSetInterval({ fireImmediately: true });
    try {
      const ticks: number[] = [];
      setInterval(() => ticks.push(1), 100);
      expect(ticks).toEqual([1]);
    } finally {
      timers.restore();
    }
  });
});

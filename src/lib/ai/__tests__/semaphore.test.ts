import { describe, it, expect } from 'bun:test';
import { Semaphore } from '@/lib/ai/semaphore';

describe('Semaphore', () => {
  it('rejects a non-positive permit count', () => {
    expect(() => new Semaphore(0)).toThrow('at least 1 permit');
    expect(() => new Semaphore(1.5)).toThrow('at least 1 permit');
  });

  it('runs immediately while permits are free', async () => {
    const semaphore = new Semaphore(2);
    expect(await semaphore.run(async () => 'done')).toBe('done');
    expect(semaphore.free).toBe(2);
  });

  it('queues work past the ceiling and admits it as permits free up', async () => {
    const semaphore = new Semaphore(1);
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      void semaphore.run(async () => {
        order.push('first-start');
        resolve();
        await new Promise<void>((done) => {
          releaseFirst = done;
        });
        order.push('first-end');
      });
    });

    await firstStarted;
    const second = semaphore.run(async () => {
      order.push('second-start');
    });

    expect(semaphore.queued).toBe(1);
    expect(order).toEqual(['first-start']);

    releaseFirst();
    await second;
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('returns the permit when the task throws', async () => {
    const semaphore = new Semaphore(1);
    await expect(
      semaphore.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(semaphore.free).toBe(1);
    expect(await semaphore.run(async () => 'ok')).toBe('ok');
  });

  it('hands a freed permit straight to a waiter rather than the pool', async () => {
    const semaphore = new Semaphore(1);
    let release: () => void = () => {};
    const blocking = semaphore.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const waiting = semaphore.run(async () => 'second');

    release();
    expect(await blocking).toBeUndefined();
    expect(await waiting).toBe('second');
    expect(semaphore.free).toBe(1);
    expect(semaphore.queued).toBe(0);
  });
});

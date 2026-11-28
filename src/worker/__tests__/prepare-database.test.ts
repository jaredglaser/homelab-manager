import { describe, it, expect, spyOn } from 'bun:test';
import { prepareDatabase } from '../prepare-database';
import type { DatabaseClient } from '@/lib/clients/database-client';

const db = {} as DatabaseClient;
const noop = async () => {};

describe('prepareDatabase', () => {
  it('migrates, then records the startup state, then starts the backfill waiting for the lock', async () => {
    const order: string[] = [];
    let finishMigrations!: () => void;
    const migrating = new Promise<void>((resolve) => { finishMigrations = resolve; });
    const shutdown = new AbortController();
    const backfill = async (_db: DatabaseClient, options?: { waitForLock?: boolean; signal?: AbortSignal }) => {
      order.push(`backfill waits on the shutdown signal: ${options?.waitForLock === true && options.signal === shutdown.signal}`);
    };

    const prepared = prepareDatabase(db, shutdown.signal, async () => { order.push('record startup state'); }, {
      migrate: async () => {
        order.push('migrate start');
        await migrating;
        order.push('migrate end');
      },
      backfill,
    });
    expect(order).toEqual(['migrate start']);
    finishMigrations();
    await (await prepared).backfill;

    expect(order).toEqual([
      'migrate start',
      'migrate end',
      'record startup state',
      'backfill waits on the shutdown signal: true',
    ]);
  });

  it('returns once migrated without waiting for a backfill that is still waiting on the lock', async () => {
    let releaseLock!: () => void;
    const lock = new Promise<void>((resolve) => { releaseLock = resolve; });
    let backfillDone = false;

    const { backfill } = await prepareDatabase(db, new AbortController().signal, noop, {
      migrate: noop,
      backfill: async () => {
        await lock;
        backfillDone = true;
      },
    });

    expect(backfillDone).toBe(false);
    releaseLock();
    await backfill;
    expect(backfillDone).toBe(true);
  });

  it('logs a failed backfill instead of rejecting', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const { backfill } = await prepareDatabase(db, new AbortController().signal, noop, {
      migrate: noop,
      backfill: async () => { throw new Error('lost connection'); },
    });

    await backfill;
    expect(errorSpy).toHaveBeenCalledWith('[Worker] Stats rollup backfill failed:', expect.any(Error));
    errorSpy.mockRestore();
  });
});

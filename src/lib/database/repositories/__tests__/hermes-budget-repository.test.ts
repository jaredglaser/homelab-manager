import { describe, it, expect, beforeEach } from 'bun:test';
import { HermesBudgetRepository, BUDGET_RETENTION_DAYS } from '../hermes-budget-repository';

function createMockPool(rows: Record<string, unknown>[] = []) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  let nextRows = rows;
  let nextRowCount: number | null = null;
  return {
    pool: {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return { rows: nextRows, rowCount: nextRowCount ?? nextRows.length };
      },
    },
    calls,
    setRows(value: Record<string, unknown>[]) {
      nextRows = value;
    },
    setRowCount(value: number | null) {
      nextRowCount = value;
    },
  };
}

describe('HermesBudgetRepository', () => {
  let mock: ReturnType<typeof createMockPool>;
  let repo: HermesBudgetRepository;

  beforeEach(() => {
    mock = createMockPool();
    repo = new HermesBudgetRepository(mock.pool as never);
  });

  describe('load', () => {
    it('returns a zeroed budget when the day has no rows', async () => {
      mock.setRows([]);
      expect(await repo.load('2026-08-16')).toEqual({ t0: 0, t1: 0, t2: 0, page: 0 });
    });

    it('maps stored buckets onto the budget shape', async () => {
      mock.setRows([
        { bucket: 't0', spent: 4 },
        { bucket: 'page', spent: 11 },
      ]);
      expect(await repo.load('2026-08-16')).toEqual({ t0: 4, t1: 0, t2: 0, page: 11 });
    });

    it('coerces the INTEGER column, which node-postgres can hand back as a string', async () => {
      mock.setRows([{ bucket: 't1', spent: '7' }]);
      const budget = await repo.load('2026-08-16');
      expect(budget.t1).toBe(7);
      expect(budget.t1 + 1).toBe(8);
    });

    it('ignores a bucket value outside the known set', async () => {
      mock.setRows([{ bucket: 'wat', spent: 99 }]);
      expect(await repo.load('2026-08-16')).toEqual({ t0: 0, t1: 0, t2: 0, page: 0 });
    });
  });

  describe('increment', () => {
    it('upserts against the (day, bucket) key', async () => {
      await repo.increment('2026-08-16', 't0', 1);
      expect(mock.calls[0].sql).toContain('ON CONFLICT (day, bucket) DO UPDATE');
      expect(mock.calls[0].params).toEqual(['2026-08-16', 't0', 1]);
    });

    it('adds to the stored value rather than replacing it', async () => {
      await repo.increment('2026-08-16', 't2', 3);
      expect(mock.calls[0].sql).toContain('hermes_budget.spent + EXCLUDED.spent');
    });
  });

  describe('pruneBefore', () => {
    it('deletes days older than the retention window', async () => {
      mock.setRowCount(6);
      expect(await repo.pruneBefore('2026-08-16')).toBe(6);
      expect(mock.calls[0].params).toEqual(['2026-08-16', BUDGET_RETENTION_DAYS]);
    });

    it('reports zero when the driver omits a row count', async () => {
      mock.setRows([]);
      mock.setRowCount(null as never);
      expect(await repo.pruneBefore('2026-08-16')).toBe(0);
    });
  });
});
